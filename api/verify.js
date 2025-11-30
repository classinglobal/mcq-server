import { NextResponse } from "next/server";
import admin from "@/lib/firebaseAdmin";
import { getGooglePlayVerifier } from "google-play-billing-validator";

export async function POST(req) {
  try {
    // -------------------------
    // STEP 1: Read request body
    // -------------------------
    const body = await req.json();

    console.log("===== Incoming Verify Request =====");
    console.log("Full Body:", body);

    const { userId, packageName, token } = body || {};

    console.log("UserID:", userId);
    console.log("Package Name:", packageName);
    console.log("Token:", token);
    console.log("===================================");

    // Missing check
    if (!packageName || !token || !userId) {
      console.error("❌ Missing required parameters");
      return NextResponse.json(
        { 
          success: false, 
          message: "Missing required parameters: userId, packageName, token" 
        },
        { status: 400 }
      );
    }

    // --------------------------
    // STEP 2: Google Play Verify
    // --------------------------
    console.log("⏳ Verifying purchase with Google...");

    const verifier = getGooglePlayVerifier({
      clientEmail: process.env.GOOGLE_CLIENT_EMAIL,
      privateKey: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    });

    const result = await verifier.verifySub({
      packageName,
      productId: "premium",
      purchaseToken: token,
    });

    console.log("Google Verify Result:", result);

    if (!result || !result.purchaseState === 0) {
      console.error("❌ Google verification failed.");
      return NextResponse.json(
        { success: false, message: "Verification failed" },
        { status: 400 }
      );
    }

    // -----------------------------
    // STEP 3: Update Firestore
    // -----------------------------
    console.log(`Updating Firestore for user ${userId}`);

    await admin
      .firestore()
      .collection("profile")
      .doc(userId)
      .update({ isPremium: true });

    console.log("✔ Firestore updated successfully");

    return NextResponse.json({
      success: true,
      message: "Verification successful",
    });

  } catch (error) {
    console.error("🔥 SERVER ERROR:", error);

    return NextResponse.json(
      {
        success: false,
        message: "Server error",
        error: error?.message || "Unknown error",
      },
      { status: 500 }
    );
  }
}
