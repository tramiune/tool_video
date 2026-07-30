/**
 * Cloudflare Pages Function: Casso Webhook Handler for meo3
 * Path: veo3-web-app/functions/api/casso-webhook.js
 */

export async function onRequestPost(context) {
  const { request, env } = context;

  // 1. Verify Casso secure API Key if configured
  const secureToken = env.CASSO_SECURE_TOKEN || env.CASSO_API_KEY;
  if (secureToken) {
    const authHeader = request.headers.get("Authorization") || request.headers.get("X-API-KEY");
    if (authHeader !== secureToken && authHeader !== `Apikey ${secureToken}`) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" }
      });
    }
  }

  try {
    const payload = await request.json();
    console.log("Casso webhook received:", JSON.stringify(payload));

    if (!payload.data || !Array.isArray(payload.data)) {
      return new Response(JSON.stringify({ error: "Invalid payload data structure" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const firebaseProjectId = env.FIREBASE_PROJECT_ID || "meo3-e69a5";
    const googleClientEmail = env.GOOGLE_CLIENT_EMAIL;
    const googlePrivateKey = env.GOOGLE_PRIVATE_KEY; // Base64 or raw PEM format

    if (!googleClientEmail || !googlePrivateKey) {
      console.error("Missing Google Service Account credentials in environment variables");
      return new Response(JSON.stringify({ error: "Server Configuration Error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }

    // Connect to Google API to get OAuth2 Access Token
    const accessToken = await getGoogleAccessToken(googleClientEmail, googlePrivateKey);

    const processedTransactions = [];

    // 2. Loop through incoming bank transactions
    for (const transaction of payload.data) {
      const description = transaction.description || "";
      const amount = transaction.amount || 0;

      // Extract transaction code from description matching VE[6 digits] (e.g. VE123456)
      const match = description.match(/VE\d{6}/i);
      if (!match) {
        console.log(`Skipping transaction: Code not found in description '${description}'`);
        continue;
      }

      const paymentCode = match[0].toUpperCase();
      console.log(`Found payment code: ${paymentCode}, Amount: ${amount}`);

      // Query Firestore via REST API to find user with pendingPayment.code == paymentCode
      const queryUrl = `https://firestore.googleapis.com/v1/projects/${firebaseProjectId}/databases/(default)/documents:runQuery`;
      const queryBody = {
        structuredQuery: {
          from: [{ collectionId: "users" }],
          where: {
            fieldFilter: {
              field: { fieldPath: "pendingPayment.code" },
              op: "EQUAL",
              value: { stringValue: paymentCode }
            }
          },
          limit: 1
        }
      };

      const queryRes = await fetch(queryUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(queryBody)
      });

      if (!queryRes.ok) {
        const errText = await queryRes.text();
        console.error(`Firestore query failed: ${errText}`);
        continue;
      }

      const queryData = await queryRes.json();
      
      // If no matching user document
      if (!queryData || !queryData[0] || !queryData[0].document) {
        console.warn(`No user found with pending payment code: ${paymentCode}`);
        continue;
      }

      const userDoc = queryData[0].document;
      const userDocName = userDoc.name; // Full resource path: projects/meo3-e69a5/databases/(default)/documents/users/userId
      const userId = userDocName.split("/").pop();

      // Retrieve current tier, expiryDate, and pendingPayment details
      const userFields = userDoc.fields || {};
      const currentTier = userFields.tier?.stringValue || "free";
      const currentExpiry = parseInt(userFields.expiryDate?.integerValue || "0", 10);
      const pendingPaymentObj = userFields.pendingPayment?.mapValue?.fields || {};
      
      const requestedTier = pendingPaymentObj.tier?.stringValue;
      const requestedAmount = parseInt(pendingPaymentObj.amount?.integerValue || "0", 10);

      if (!requestedTier) {
        console.error(`Requested tier not defined for user ${userId}`);
        continue;
      }

      // 3. Security Verification: Compare amounts
      if (amount < requestedAmount) {
        console.warn(`Insufficient payment amount. Paid: ${amount}, Expected: ${requestedAmount}`);
        // Log transaction fail on Telegram
        await sendTelegramNotification(
          env.TELEGRAM_BOT_TOKEN,
          env.TELEGRAM_CHAT_ID,
          `⚠️ *Cảnh báo nạp tiền thiếu (meo3)*\n- User ID: \`${userId}\`\n- Code: \`${paymentCode}\`\n- Số tiền cần: \`${requestedAmount.toLocaleString("vi-VN")}đ\`\n- Thực chuyển: \`${amount.toLocaleString("vi-VN")}đ\`\n- Trạng thái: *Không duyệt*`
        );
        continue;
      }

      // 4. Calculate new expiry date (+30 days)
      const isExpired = currentExpiry < Date.now();
      const newExpiry = (isExpired ? Date.now() : currentExpiry) + 30 * 24 * 60 * 60 * 1000;

      // 5. Update user document inside Firestore: Set new tier, new expiryDate, clear pendingPayment
      const updateUrl = `https://firestore.googleapis.com/v1/${userDocName}?updateMask.fieldPaths=tier&updateMask.fieldPaths=expiryDate&updateMask.fieldPaths=pendingPayment`;
      
      const updateBody = {
        fields: {
          ...userFields,
          tier: { stringValue: requestedTier },
          expiryDate: { integerValue: String(newExpiry) },
          pendingPayment: { nullValue: null }
        }
      };

      const updateRes = await fetch(updateUrl, {
        method: "PATCH",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(updateBody)
      });

      if (!updateRes.ok) {
        const updateErr = await updateRes.text();
        console.error(`Failed to update user document: ${updateErr}`);
        continue;
      }

      console.log(`Successfully upgraded user ${userId} to ${requestedTier} tier until ${new Date(newExpiry).toISOString()}`);
      
      // Save for response
      processedTransactions.push({ userId, paymentCode, tier: requestedTier, amount });

      // 6. Post Notification to Telegram channel
      const tierName = requestedTier === "premium_169k" ? "Premium (169k)" : (requestedTier === "standard_99k" ? "Standard (99k)" : "Basic (69k)");
      const telegramMsg = `✨ *Giao dịch nạp tiền thành công (meo3)*\n\n` +
                          `- User ID: \`${userId}\`\n` +
                          `- Gói nâng cấp: *${tierName}*\n` +
                          `- Số tiền: \`${amount.toLocaleString("vi-VN")}đ\`\n` +
                          `- Nội dung quét: \`${paymentCode}\`\n` +
                          `- Thời hạn mới: \`${new Date(newExpiry).toLocaleDateString("vi-VN")}\`\n` +
                          `- Trạng thái: *Đã duyệt tự động* ✅`;
                          
      await sendTelegramNotification(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, telegramMsg);
    }

    return new Response(JSON.stringify({ success: true, processed: processedTransactions }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    console.error("Webhook processing crashed:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}

/**
 * Generates OAuth2 Token using Google Service Account JWT
 */
async function getGoogleAccessToken(clientEmail, privateKeyPEM) {
  const jwt = await generateJWT(clientEmail, privateKeyPEM);
  
  const tokenUrl = "https://oauth2.googleapis.com/token";
  const params = new URLSearchParams();
  params.append("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer");
  params.append("assertion", jwt);
  
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });
  
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to exchange JWT: ${errText}`);
  }
  
  const data = await res.json();
  return data.access_token;
}

/**
 * JWT RSASHA256 generator utilizing Web Crypto APIs for Cloudflare Workers compatibility
 */
async function generateJWT(clientEmail, privateKeyPEM) {
  // Remove PEM headers and parse base64 private key bytes
  const pemHeader = "-----BEGIN PRIVATE KEY-----";
  const pemFooter = "-----END PRIVATE KEY-----";
  const pemContents = privateKeyPEM
    .replace(pemHeader, "")
    .replace(pemFooter, "")
    .replace(/\s+/g, "");
  
  const binaryDerString = atob(pemContents);
  const binaryLen = binaryDerString.length;
  const bytes = new Uint8Array(binaryLen);
  for (let i = 0; i < binaryLen; i++) {
    bytes[i] = binaryDerString.charCodeAt(i);
  }
  
  // Import PKCS8 Private Key
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    bytes.buffer,
    {
      name: "RSASHA256",
      hash: { name: "SHA-256" }
    },
    false,
    ["sign"]
  );
  
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  };
  
  const base64UrlHeader = btoa(JSON.stringify(header)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const base64UrlPayload = btoa(JSON.stringify(payload)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  
  const tokenInput = `${base64UrlHeader}.${base64UrlPayload}`;
  const encoder = new TextEncoder();
  const tokenInputBytes = encoder.encode(tokenInput);
  
  const signature = await crypto.subtle.sign("RSASHA256", privateKey, tokenInputBytes);
  
  const base64UrlSignature = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
    
  return `${tokenInput}.${base64UrlSignature}`;
}

/**
 * Sends a message notification to Telegram group
 */
async function sendTelegramNotification(botToken, chatId, message) {
  if (!botToken || !chatId) return;
  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "Markdown"
      })
    });
  } catch (e) {
    console.error("Telegram post failed:", e);
  }
}
