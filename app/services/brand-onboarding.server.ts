import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import prisma from "../db.server";
import type { AdminGraphqlClient } from "../models/products.server";

export interface ShopInfo {
  name: string;
  email: string;
  contactEmail: string;
  url: string;
  myshopifyDomain: string;
  phone: string | null;
}

export interface OnboardingResult {
  success: boolean;
  brandId?: string;
  clerkUserId?: string;
  brandName?: string;
  contactEmail?: string;
  tempPassword?: string;
  isExistingUser?: boolean;
  emailSent?: boolean;
  error?: string;
}

/** Generates a cryptographically strong 16-character temporary password. */
export function generateSecurePassword(length = 16): string {
  const lowercase = "abcdefghjkmnpqrstuvwxyz";
  const uppercase = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const numbers = "23456789";
  const special = "!@#$%^&*";
  const all = lowercase + uppercase + numbers + special;

  const chars: string[] = [
    lowercase[randomBytes(1)[0] % lowercase.length],
    uppercase[randomBytes(1)[0] % uppercase.length],
    numbers[randomBytes(1)[0] % numbers.length],
    special[randomBytes(1)[0] % special.length],
  ];

  while (chars.length < length) {
    chars.push(all[randomBytes(1)[0] % all.length]);
  }

  // Shuffle
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomBytes(1)[0] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

function slugify(text: string): string {
  return (text || "")
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function toClerkUsername(text: string): string {
  const clean = (text || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_]/g, "");
  if (clean.length < 4) {
    return `brand_${clean}_${Math.floor(1000 + Math.random() * 9000)}`;
  }
  return clean.slice(0, 48);
}

/** Fetches verified shop profile details from Shopify GraphQL. */
export async function fetchShopDetails(
  admin: AdminGraphqlClient,
): Promise<ShopInfo | null> {
  try {
    const response = await admin.graphql(
      `#graphql
      query ShopDetails {
        shop {
          name
          email
          contactEmail
          url
          myshopifyDomain
          billingAddress {
            phone
          }
        }
      }`,
    );

    const json = await response.json();
    const data = json?.data?.shop;
    if (!data) return null;

    return {
      name: data.name || "Brand",
      email: data.email || "",
      contactEmail: data.contactEmail || data.email || "",
      url: data.url || "",
      myshopifyDomain: data.myshopifyDomain || "",
      phone: data.billingAddress?.phone || null,
    };
  } catch (err: any) {
    console.error("[brand-onboarding] Error querying shop details from Shopify:", err.message);
    return null;
  }
}

/**
 * Creates or updates a Clerk user account using the Clerk Backend REST API.
 */
export async function createOrUpdateClerkUser(
  email: string,
  brandName: string,
  tempPassword: string,
  shop: string,
): Promise<{ clerkUserId: string; isExisting: boolean }> {
  const clerkKey = process.env.CLERK_SECRET_KEY;
  if (!clerkKey) {
    throw new Error("CLERK_SECRET_KEY is not configured in environment");
  }

  const trimmedEmail = email.trim().toLowerCase();
  const username = toClerkUsername(brandName);

  // 1. Try to create user
  const createRes = await fetch("https://api.clerk.com/v1/users", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${clerkKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email_address: [trimmedEmail],
      username,
      password: tempPassword,
      public_metadata: {
        role: "brand",
        shop,
        forcePasswordReset: true,
      },
      skip_password_checks: true,
      skip_password_requirement: false,
    }),
  });

  const createJson = await createRes.json();

  if (createRes.ok && createJson?.id) {
    console.log(`[brand-onboarding] Created new Clerk user: ${createJson.id} for ${trimmedEmail}`);
    return { clerkUserId: createJson.id, isExisting: false };
  }

  // 2. If user already exists, update their password and metadata
  const isDuplicate =
    createJson?.errors?.some((e: any) => e.code === "form_identifier_exists") ||
    createRes.status === 422;

  if (isDuplicate) {
    console.log(`[brand-onboarding] Clerk user already exists for ${trimmedEmail}, updating...`);
    const searchRes = await fetch(
      `https://api.clerk.com/v1/users?email_address=${encodeURIComponent(trimmedEmail)}`,
      {
        headers: { Authorization: `Bearer ${clerkKey}` },
      },
    );
    const searchJson = await searchRes.json();
    const existing = Array.isArray(searchJson) ? searchJson[0] : null;

    if (existing?.id) {
      await fetch(`https://api.clerk.com/v1/users/${existing.id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${clerkKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          password: tempPassword,
          public_metadata: {
            role: "brand",
            shop,
            forcePasswordReset: true,
          },
        }),
      });
      return { clerkUserId: existing.id, isExisting: true };
    }
  }

  throw new Error(
    `Failed to create Clerk user: ${JSON.stringify(createJson?.errors || createJson)}`,
  );
}

/**
 * Saves or updates brand in public.brands (PRODUCTS_DB) and links shopify_connector.ShopifyStore.
 */
export async function saveBrandInProductDb(
  shop: string,
  clerkUserId: string,
  info: ShopInfo,
): Promise<{ brandId: string; brandName: string }> {
  const productsDbUrl = process.env.PRODUCTS_DB || process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!productsDbUrl) {
    throw new Error("PRODUCTS_DB is not configured in environment");
  }

  const legacy = new PrismaClient({ datasourceUrl: productsDbUrl });
  try {
    const slug = slugify(info.name);

    // 1. Check if brand exists by clerk_user_id or brand_name or contact_email
    const existingBrands = await legacy.$queryRawUnsafe<Array<{ id: string; brand_name: string }>>(
      `SELECT id::text, brand_name 
       FROM public.brands 
       WHERE clerk_user_id = $1 
          OR LOWER(TRIM(brand_name)) = LOWER(TRIM($2)) 
          OR contact_email = $3
       LIMIT 1`,
      clerkUserId,
      info.name,
      info.contactEmail,
    );

    let brandId: string;
    let finalBrandName = info.name;

    if (existingBrands.length > 0) {
      brandId = existingBrands[0].id;
      finalBrandName = existingBrands[0].brand_name;
      await legacy.$executeRawUnsafe(
        `UPDATE public.brands 
         SET clerk_user_id = $1, 
             contact_email = $2, 
             contact_phone = COALESCE($3, contact_phone), 
             website = COALESCE($4, website),
             updated_at = now()
         WHERE id = $5::uuid`,
        clerkUserId,
        info.contactEmail,
        info.phone,
        info.url,
        brandId,
      );
      console.log(`[brand-onboarding] Updated existing brand in DB: ${finalBrandName} (${brandId})`);
    } else {
      const inserted = await legacy.$queryRawUnsafe<Array<{ id: string; brand_name: string }>>(
        `INSERT INTO public.brands (
           id, clerk_user_id, brand_name, contact_email, contact_phone, 
           website, slug, is_onboarded, is_aeza_catalog, created_at, updated_at
         ) VALUES (
           gen_random_uuid(), $1, $2, $3, $4, $5, $6, false, true, now(), now()
         )
         RETURNING id::text, brand_name`,
        clerkUserId,
        info.name,
        info.contactEmail,
        info.phone,
        info.url,
        slug,
      );
      brandId = inserted[0].id;
      finalBrandName = inserted[0].brand_name;
      console.log(`[brand-onboarding] Created new brand in DB: ${finalBrandName} (${brandId})`);
    }

    // 2. Link legacyBrandId and legacyBrandName on ShopifyStore in ops DB
    await prisma.shopifyStore.updateMany({
      where: { shop },
      data: {
        legacyBrandId: brandId,
        legacyBrandName: finalBrandName,
      },
    });

    return { brandId, brandName: finalBrandName };
  } finally {
    await legacy.$disconnect();
  }
}

/**
 * Sends email notification to the Aeza team containing login credentials and store details.
 */
export async function sendOnboardingNotificationEmail(params: {
  shop: string;
  brandName: string;
  brandId: string;
  clerkUserId: string;
  contactEmail: string;
  tempPassword: string;
  website: string;
  phone: string | null;
  isExistingUser: boolean;
}): Promise<boolean> {
  const recipient =
    process.env.ADMIN_NOTIFICATION_EMAIL ||
    process.env.CONTRACT_SIGNED_RECIPIENTS ||
    "teni@aeza.in";

  const subject = `🎉 New Brand Installed: ${params.brandName} (${params.shop})`;
  const dashboardUrl = "https://analytics.aeza.in";

  const htmlBody = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #eaeaea; border-radius: 8px;">
      <h2 style="color: #111; margin-top: 0;">New Brand Installed Aeza Shopify App</h2>
      <p style="color: #444; font-size: 15px;">
        <strong>${params.brandName}</strong> just installed the Aeza Shopify app. Their Clerk account has been created and synced with the brands database.
      </p>

      <div style="background-color: #f7f9fa; border-radius: 6px; padding: 16px; margin: 20px 0;">
        <h3 style="margin-top: 0; color: #222; font-size: 15px;">Brand Credentials & Details</h3>
        <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
          <tr>
            <td style="padding: 6px 0; color: #666; width: 140px;">Brand Name:</td>
            <td style="padding: 6px 0; font-weight: 600; color: #111;">${params.brandName}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #666;">Shopify Store:</td>
            <td style="padding: 6px 0; color: #111;"><code>${params.shop}</code></td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #666;">Website:</td>
            <td style="padding: 6px 0;"><a href="${params.website}" target="_blank">${params.website || "N/A"}</a></td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #666;">Contact Phone:</td>
            <td style="padding: 6px 0; color: #111;">${params.phone || "N/A"}</td>
          </tr>
          <tr style="border-top: 1px solid #e1e4e8;">
            <td style="padding: 10px 0 6px 0; color: #666;"><strong>Login Email:</strong></td>
            <td style="padding: 10px 0 6px 0; font-weight: 600; color: #0066cc;">${params.contactEmail}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #666;"><strong>Temp Password:</strong></td>
            <td style="padding: 6px 0; font-family: monospace; font-size: 15px; font-weight: bold; background: #fff; padding: 4px 8px; border-radius: 4px; border: 1px solid #ddd; display: inline-block;">${params.tempPassword}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #666;">Clerk User ID:</td>
            <td style="padding: 6px 0; font-size: 12px; color: #555;"><code>${params.clerkUserId}</code></td>
          </tr>
          <tr>
            <td style="padding: 6px 0; color: #666;">Database Brand ID:</td>
            <td style="padding: 6px 0; font-size: 12px; color: #555;"><code>${params.brandId}</code></td>
          </tr>
        </table>
      </div>

      <p style="font-size: 13px; color: #666;">
        Merchant status: <strong>${params.isExistingUser ? "Existing Clerk user (password refreshed)" : "New Clerk user created"}</strong>.<br/>
        The password requires a reset on first login.
      </p>

      <div style="margin-top: 24px;">
        <a href="${dashboardUrl}" style="background-color: #000; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-weight: 500; font-size: 14px; display: inline-block;">Open Brands Analytics</a>
      </div>
    </div>
  `;

  const textBody = `
NEW BRAND INSTALLED AEZA SHOPIFY APP
-------------------------------------
Brand Name: ${params.brandName}
Shop: ${params.shop}
Website: ${params.website || "N/A"}
Phone: ${params.phone || "N/A"}

LOGIN CREDENTIALS:
Login Email: ${params.contactEmail}
Temporary Password: ${params.tempPassword}

Clerk User ID: ${params.clerkUserId}
Database Brand ID: ${params.brandId}
Account Status: ${params.isExistingUser ? "Existing user (password reset)" : "New account created"}
  `.trim();

  // 1. Try Resend API if RESEND_API_KEY is configured
  const resendApiKey = process.env.RESEND_API_KEY;
  if (resendApiKey) {
    try {
      const from = process.env.EMAIL_FROM_ADDRESS || "Aeza Onboarding <onboarding@aeza.in>";
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: recipient.split(",").map((e) => e.trim()),
          subject,
          html: htmlBody,
          text: textBody,
        }),
      });
      if (res.ok) {
        console.log(`[brand-onboarding] Sent onboarding email via Resend to ${recipient}`);
        return true;
      }
      const errText = await res.text();
      console.warn("[brand-onboarding] Resend returned non-200:", errText);
    } catch (err: any) {
      console.error("[brand-onboarding] Failed to send email via Resend:", err.message);
    }
  }

  // 2. Try SMTP if configured in environment
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  if (smtpUser && smtpPass) {
    try {
      const nodemailer = await import("nodemailer");
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || "smtp.gmail.com",
        port: parseInt(process.env.SMTP_PORT || "587", 10),
        secure: process.env.SMTP_PORT === "465",
        auth: { user: smtpUser, pass: smtpPass },
      });

      await transporter.sendMail({
        from: `"Aeza Onboarding" <${smtpUser}>`,
        to: recipient,
        subject,
        text: textBody,
        html: htmlBody,
      });

      console.log(`[brand-onboarding] Sent onboarding email via SMTP to ${recipient}`);
      return true;
    } catch (err: any) {
      console.error("[brand-onboarding] Failed to send email via SMTP:", err.message);
    }
  }

  // 3. Fallback: Log prominently to server console so credentials are never lost
  console.log(`
========================================================================
[BRAND ONBOARDING CREDENTIALS CREATED]
Brand: ${params.brandName} (${params.shop})
Email: ${params.contactEmail}
Password: ${params.tempPassword}
Clerk User ID: ${params.clerkUserId}
Brand ID: ${params.brandId}
Recipient: ${recipient}
========================================================================
  `);

  return false;
}

/**
 * Main entrypoint called on Shopify app installation (afterAuth).
 * Safe: Errors are caught and logged so app installation is never aborted.
 */
export async function autoOnboardBrandOnInstall(
  shop: string,
  admin: AdminGraphqlClient,
): Promise<OnboardingResult> {
  console.log(`[brand-onboarding] Starting automatic onboarding for ${shop}...`);

  try {
    // 1. Fetch shop profile from Shopify GraphQL
    const shopInfo = await fetchShopDetails(admin);
    if (!shopInfo || !shopInfo.contactEmail) {
      console.warn(`[brand-onboarding] Could not fetch contact email for ${shop}`);
      return { success: false, error: "Missing shop contact email" };
    }

    // 2. Generate secure password
    const tempPassword = generateSecurePassword();

    // 3. Create or update Clerk account
    const { clerkUserId, isExisting } = await createOrUpdateClerkUser(
      shopInfo.contactEmail,
      shopInfo.name,
      tempPassword,
      shop,
    );

    // 4. Save/update brand in public.brands (PRODUCTS_DB)
    const { brandId, brandName } = await saveBrandInProductDb(
      shop,
      clerkUserId,
      shopInfo,
    );

    // 5. Store clerkId in shopify_connector.BrandProfile and link store
    try {
      const bp = await prisma.brandProfile.upsert({
        where: { shop },
        update: {
          clerkId: clerkUserId,
        },
        create: {
          id: brandId,
          shop,
          brandName: shopInfo.name,
          contactEmail: shopInfo.contactEmail,
          contactPhone: shopInfo.phone || "",
          websiteUrl: shopInfo.url,
          status: "pending_review",
          clerkId: clerkUserId,
        },
      });

      await prisma.shopifyStore.updateMany({
        where: { shop },
        data: { brandProfileId: bp.id },
      });
      console.log(`[brand-onboarding] Saved clerkId=${clerkUserId} in BrandProfile for ${shop}`);
    } catch (bpErr: any) {
      console.error(`[brand-onboarding] Failed to update BrandProfile clerkId for ${shop}:`, bpErr.message);
    }

    // 6. Send notification email with credentials
    const emailSent = await sendOnboardingNotificationEmail({
      shop,
      brandName,
      brandId,
      clerkUserId,
      contactEmail: shopInfo.contactEmail,
      tempPassword,
      website: shopInfo.url,
      phone: shopInfo.phone,
      isExistingUser: isExisting,
    });

    return {
      success: true,
      brandId,
      clerkUserId,
      brandName,
      contactEmail: shopInfo.contactEmail,
      tempPassword,
      isExistingUser: isExisting,
      emailSent,
    };
  } catch (error: any) {
    console.error(`[brand-onboarding] Automatic onboarding failed for ${shop}:`, error);
    return {
      success: false,
      error: error.message || "Unknown onboarding error",
    };
  }
}
