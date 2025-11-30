import { NextResponse } from "next/server";
import admin from "@/lib/firebaseAdmin"; // আপনার Firebase Admin সেটআপ
import { google } from "googleapis";

export async function POST(req) {
  try {
    // -------------------------
    // STEP 1: Read request body
    // -------------------------
    const body = await req.json();
    const { userId, packageName, token, subscriptionId } = body || {};

    console.log(`🚀 Verify Request: User=${userId}, Pkg=${packageName}, SubId=${subscriptionId}`);

    // Missing check
    if (!packageName || !token || !userId || !subscriptionId) {
      console.error("❌ Missing required parameters");
      return NextResponse.json(
        { success: false, message: "Missing required parameters" },
        { status: 400 }
      );
    }

    // --------------------------
    // STEP 2: Google Play Verify (Using Official googleapis)
    // --------------------------
    
    // Environment Variables থেকে চাবি নেওয়া
    const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
    const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");

    if (!clientEmail || !privateKey) {
        throw new Error("Server Credentials Missing (GOOGLE_CLIENT_EMAIL or GOOGLE_PRIVATE_KEY)");
    }

    // Auth Client তৈরি করা
    const auth = new google.auth.JWT({
      email: clientEmail,
      key: privateKey,
      scopes: ["https://www.googleapis.com/auth/androidpublisher"],
    });

    const androidpublisher = google.androidpublisher({
      version: "v3",
      auth: auth,
    });

    // ভেরিফিকেশন কল
    console.log("⏳ Verifying with Google...");
    const response = await androidpublisher.purchases.subscriptionsv2.get({
      packageName: packageName,
      token: token,
    });

    const subData = response.data;
    
    // স্ট্যাটাস চেক
    const isActive = subData.subscriptionState === "SUBSCRIPTION_STATE_ACTIVE";
    // মেয়াদ শেষ হওয়ার সময় (Expiry Time)
    const expiryMillis = subData.subscriptionPurchase?.expiryTimeMillis || subData.expiryTimeMillis;
    const expiryTime = expiryMillis ? Number(expiryMillis) : 0;
    const isExpired = expiryTime <= Date.now();

    // -----------------------------
    // STEP 3: Update Firestore
    // -----------------------------
    const db = admin.firestore();
    const userRef = db.collection("profile").doc(userId);

    if (isActive && !isExpired) {
      // ✅ সফল: premiumPlan নাম ব্যবহার করা হয়েছে এবং merge: true দেওয়া হয়েছে
      await userRef.set({
        premiumPlan: true, 
        premiumExpiry: expiryTime,
        lastVerified: Date.now(),
        lastSubId: subscriptionId
      }, { merge: true });

      console.log(`✔ Success: Premium activated for ${userId}`);

      return NextResponse.json({
        ok: true, // অ্যাপ এই ফিল্ড চেক করে
        active: true,
        expiryMillis: expiryTime,
        success: true
      });

    } else {
      // ❌ মেয়াদ শেষ
      await userRef.set({
        premiumPlan: false,
        premiumExpiry: expiryTime
      }, { merge: true });

      console.log(`❌ Subscription inactive/expired for ${userId}`);

      return NextResponse.json({
        ok: true, 
        active: false,
        reason: "Inactive or Expired",
        success: true
      });
    }

  } catch (error) {
    console.error("🔥 SERVER ERROR:", error.message);
    
    // Google API Error ডিটেইলস দেখার জন্য
    if (error.response) {
        console.error("Google API Error:", JSON.stringify(error.response.data));
    }

    return NextResponse.json(
      {
        success: false,
        message: "Server error",
        error: error.message,
      },
      { status: 500 }
    );
  }
}
