const { google } = require('googleapis');
const admin = require('firebase-admin');

module.exports = async (req, res) => {
    // ১. শুধু POST রিকোয়েস্ট গ্রহণ
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        // ✅✅✅ ফিক্স: বডি পার্সিং (সবচেয়ে জরুরি) ✅✅✅
        let data = req.body;

        // যদি Vercel ডাটাকে স্ট্রিং হিসেবে পায়, তবে আমরা জোর করে JSON বানাবো
        if (typeof data === 'string') {
            try {
                data = JSON.parse(data);
            } catch (e) {
                console.error("JSON Parse Error:", e.message);
                return res.status(400).json({ error: "Invalid JSON format sent from App" });
            }
        }

        // ডিবাগিং লগ (Vercel Logs-এ দেখার জন্য)
        console.log("Processed Body:", JSON.stringify(data));

        // ২. Environment Variables চেক
        if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON || !process.env.PLAY_SERVICE_ACCOUNT_JSON) {
            throw new Error("MISSING_SERVER_KEYS");
        }

        let firebaseCreds, playCreds;
        try {
            firebaseCreds = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
            playCreds = JSON.parse(process.env.PLAY_SERVICE_ACCOUNT_JSON);
        } catch (e) { throw new Error("INVALID_KEY_FORMAT"); }

        // ৩. Firebase কানেকশন
        if (admin.apps.length === 0) {
            admin.initializeApp({ credential: admin.credential.cert(firebaseCreds) });
        }
        const db = admin.firestore();

        // ৪. Google Play কানেকশন
        const auth = new google.auth.GoogleAuth({
            credentials: playCreds,
            scopes: ['https://www.googleapis.com/auth/androidpublisher'],
        });
        const androidpublisher = google.androidpublisher({ version: 'v3', auth });

        // ৫. ডাটা ভেরিফিকেশন (এখন 'req.body' এর বদলে 'data' ব্যবহার করছি)
        const { packageName, token, subscriptionId, userId } = data;

        if (!packageName || !token || !subscriptionId || !userId) {
            console.error("Missing Fields in:", data);
            return res.status(400).json({ error: 'Missing required parameters: packageName, token' });
        }

        // ৬. Google Play API কল
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

        if (isActiveSub && !isExpired) {
            await userDocRef.set({
                premiumPlan: true, 
                premiumExpiry: expiryTime,
                lastVerified: Date.now(),
                lastSubId: subscriptionId
            }, { merge: true });
            
            return res.status(200).json({ ok: true, active: true, expiryMillis: expiryTime });
        } else {
            await userDocRef.set({ 
                premiumPlan: false,
                premiumExpiry: expiryTime
            }, { merge: true });
            
            return res.status(200).json({ ok: true, active: false, reason: 'Inactive' });
        }

    } catch (e) {
        console.error("CRASH ERROR:", e.message);
        if (e.response && e.response.data) {
            console.error("Google API Error:", JSON.stringify(e.response.data));
        }
        return res.status(500).json({ error: e.message });
    }
};
