const { google } = require('googleapis');
const admin = require('firebase-admin');

module.exports = async (req, res) => {
    // ১. মেথড চেক
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        // ২. ডাটা রিসিভ ও পার্স করা
        let data = req.body;
        
        // যদি স্ট্রিং হিসেবে আসে, জেসন বানাও
        if (typeof data === 'string') {
            try {
                data = JSON.parse(data);
            } catch (e) {
                return res.status(400).json({ error: "Invalid JSON format" });
            }
        }

        // ৩. ভেরিয়েবল আলাদা করা
        const packageName = data.packageName;
        const token = data.token;
        const subscriptionId = data.subscriptionId;
        const userId = data.userId;

        // ৪. ডিবাগ লগ (Vercel লগে দেখার জন্য)
        console.log("--- FINAL CHECK ---");
        console.log(`PKG: ${packageName}`);
        console.log(`SUB: ${subscriptionId}`);
        console.log(`USR: ${userId}`);
        console.log(`TOK: ${token ? token.substring(0, 20) + '...' : 'MISSING'}`);
        console.log("-------------------");

        // ৫. ভ্যালিডেশন (সঠিক ভেরিয়েবল চেক)
        if (!packageName || !token || !subscriptionId || !userId) {
            console.error("🔴 Validation Failed!");
            return res.status(400).json({ 
                error: 'Missing required parameters',
                details: `Received: Pkg=${!!packageName}, Tok=${!!token}, Sub=${!!subscriptionId}, User=${!!userId}`
            });
        }

        // ৬. চাবি (Keys) লোড করা
        if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON || !process.env.PLAY_SERVICE_ACCOUNT_JSON) {
            throw new Error("SERVER_KEYS_MISSING_IN_ENV");
        }

        const firebaseCreds = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
        const playCreds = JSON.parse(process.env.PLAY_SERVICE_ACCOUNT_JSON);

        // ৭. কানেকশন সেটআপ
        if (admin.apps.length === 0) {
            admin.initializeApp({ credential: admin.credential.cert(firebaseCreds) });
        }
        const db = admin.firestore();

        const auth = new google.auth.GoogleAuth({
            credentials: playCreds,
            scopes: ['https://www.googleapis.com/auth/androidpublisher'],
        });
        const androidpublisher = google.androidpublisher({ version: 'v3', auth });

        // ৮. Google Play ভেরিফিকেশন (আসল কাজ)
        console.log("🔄 Calling Google API...");
        
        const response = await androidpublisher.purchases.subscriptionsv2.get({
            name: `applications/${packageName}/purchases/subscriptionsv2/tokens/${token}`
        });

        console.log("✅ Google API Response: Success");

        const subData = response.data;
        
        // ৯. লজিক ও ডেটাবেস আপডেট
        const expiryMillis = subData?.subscriptionPurchase?.expiryTimeMillis || subData?.expiryTimeMillis;
        const expiryTime = expiryMillis ? Number(expiryMillis) : 0;
        const isActiveSub = subData.subscriptionState === 'SUBSCRIPTION_STATE_ACTIVE';
        const isExpired = expiryTime <= Date.now();

        const userDocRef = db.collection('profile').doc(userId);

        if (isActiveSub && !isExpired) {
            await userDocRef.set({
                premiumPlan: true, 
                premiumExpiry: expiryTime,
                lastVerified: Date.now(),
                lastSubId: subscriptionId
            }, { merge: true });
            
            console.log(`🎉 Activated Premium for ${userId}`);
            return res.status(200).json({ ok: true, active: true, expiryMillis: expiryTime });

        } else {
            await userDocRef.set({ 
                premiumPlan: false,
                premiumExpiry: expiryTime
            }, { merge: true });
            
            console.log(`⛔ Expired/Inactive for ${userId}`);
            return res.status(200).json({ ok: true, active: false, reason: 'Inactive' });
        }

    } catch (e) {
        console.error("🔴 SERVER ERROR:", e.message);
        // Google API-এর বিস্তারিত এরর
        if (e.response && e.response.data) {
            console.error("Google Error Details:", JSON.stringify(e.response.data));
        }
        return res.status(500).json({ error: e.message });
    }
};