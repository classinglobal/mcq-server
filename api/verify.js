const { google } = require('googleapis');
const admin = require('firebase-admin');

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        // ১. বডি পার্সিং (কঠোরভাবে)
        let data = req.body;
        if (typeof data === 'string') {
            try {
                data = JSON.parse(data);
            } catch (e) {
                return res.status(400).json({ error: "Invalid JSON string" });
            }
        }

        const { packageName, token, subscriptionId, userId } = data || {};

        // ✅✅✅ ডিবাগ লগ (কোনটা আছে আর কোনটা নাই) ✅✅✅
        console.log("--- DATA CHECK ---");
        console.log(`1. Package: ${packageName ? '✅ Found (' + packageName + ')' : '❌ MISSING'}`);
        console.log(`2. User ID: ${userId ? '✅ Found' : '❌ MISSING'}`);
        console.log(`3. Sub ID : ${subscriptionId ? '✅ Found (' + subscriptionId + ')' : '❌ MISSING'}`);
        console.log(`4. Token  : ${token ? '✅ Found (Length: ' + token.length + ')' : '❌ MISSING'}`);
        console.log("------------------");

        // ২. স্পেসিফিক এরর চেক
        const missingFields = [];
        if (!packageName) missingFields.push('packageName');
        if (!token) missingFields.push('token');
        if (!subscriptionId) missingFields.push('subscriptionId');
        if (!userId) missingFields.push('userId');

        if (missingFields.length > 0) {
            // সার্ভার এখন ঠিক বলে দেবে কি নেই
            throw new Error(`MISSING_FIELDS: ${missingFields.join(', ')}`);
        }

        // ৩. চাবি লোড করা
        if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON || !process.env.PLAY_SERVICE_ACCOUNT_JSON) {
            throw new Error("SERVER_KEYS_MISSING");
        }

        const firebaseCreds = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
        const playCreds = JSON.parse(process.env.PLAY_SERVICE_ACCOUNT_JSON);

        // ৪. Firebase কানেকশন
        if (admin.apps.length === 0) {
            admin.initializeApp({ credential: admin.credential.cert(firebaseCreds) });
        }
        const db = admin.firestore();

        // ৫. Google Play কানেকশন
        const auth = new google.auth.GoogleAuth({
            credentials: playCreds,
            scopes: ['https://www.googleapis.com/auth/androidpublisher'],
        });
        const androidpublisher = google.androidpublisher({ version: 'v3', auth });

        // ৬. ভেরিফিকেশন কল
        const response = await androidpublisher.purchases.subscriptionsv2.get({
            name: `applications/${packageName}/purchases/subscriptionsv2/tokens/${token}`
        });

        const subData = response.data;
        const expiryMillis = subData?.subscriptionPurchase?.expiryTimeMillis || subData?.expiryTimeMillis;
        const expiryTime = expiryMillis ? Number(expiryMillis) : 0;
        const isActiveSub = subData.subscriptionState === 'SUBSCRIPTION_STATE_ACTIVE';
        const isExpired = expiryTime <= Date.now();

        // ৭. ডাটাবেস আপডেট
        const userDocRef = db.collection('profile').doc(userId);
        await userDocRef.set({
            premiumPlan: isActiveSub && !isExpired, 
            premiumExpiry: expiryTime,
            lastVerified: Date.now(),
            lastSubId: subscriptionId
        }, { merge: true });

        return res.status(200).json({ ok: true, active: isActiveSub && !isExpired });

    } catch (e) {
        console.error("🔴 ERROR:", e.message);
        if (e.response) {
            console.error("Google API Error:", JSON.stringify(e.response.data));
        }
        return res.status(500).json({ error: e.message });
    }
};