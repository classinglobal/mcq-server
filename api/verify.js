const { google } = require('googleapis');
const admin = require('firebase-admin');

module.exports = async (req, res) => {
    // ১. শুধু POST রিকোয়েস্ট গ্রহণ করা হবে
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        // ২. Environment Variables (Keys) চেক ও লোড করা
        if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) throw new Error("MISSING_FIREBASE_KEY");
        if (!process.env.PLAY_SERVICE_ACCOUNT_JSON) throw new Error("MISSING_PLAY_KEY");

        let firebaseCreds, playCreds;
        try {
            firebaseCreds = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
        } catch (e) { throw new Error("INVALID_FIREBASE_JSON_FORMAT"); }

        try {
            playCreds = JSON.parse(process.env.PLAY_SERVICE_ACCOUNT_JSON);
        } catch (e) { throw new Error("INVALID_PLAY_JSON_FORMAT"); }

        // ৩. Firebase Admin SDK ইনিশিয়ালাইজ করা
        if (admin.apps.length === 0) {
            admin.initializeApp({
                credential: admin.credential.cert(firebaseCreds)
            });
        }
        const db = admin.firestore();

        // ৪. Google Play API সেটআপ
        const auth = new google.auth.GoogleAuth({
            credentials: playCreds,
            scopes: ['https://www.googleapis.com/auth/androidpublisher'],
        });
        const androidpublisher = google.androidpublisher({ version: 'v3', auth });

        // ৫. অ্যাপ থেকে আসা ডাটা চেক করা
        const { packageName, token, subscriptionId, userId } = req.body;

        // ডিবাগিং-এর জন্য লগ (Vercel Logs-এ দেখা যাবে)
        console.log(`Processing verification for User: ${userId}, Package: ${packageName}`);

        if (!packageName || !token || !subscriptionId || !userId) {
            return res.status(400).json({ error: 'Missing required fields (packageName, token, subscriptionId, userId)' });
        }

        // ৬. Google Play API কল করে ভেরিফাই করা
        const response = await androidpublisher.purchases.subscriptionsv2.get({
            name: `applications/${packageName}/purchases/subscriptionsv2/tokens/${token}`
        });

        const subData = response.data;
        
        // মেয়াদ এবং স্ট্যাটাস চেক
        const expiryMillis = subData?.subscriptionPurchase?.expiryTimeMillis || subData?.expiryTimeMillis;
        const expiryTime = expiryMillis ? Number(expiryMillis) : 0;
        const isActiveSub = subData.subscriptionState === 'SUBSCRIPTION_STATE_ACTIVE';
        const isExpired = expiryTime <= Date.now();

        // ৭. Firestore ডাটাবেস আপডেট (profile কালেকশন)
        const userDocRef = db.collection('profile').doc(userId);

        if (isActiveSub && !isExpired) {
            // সফল: প্রিমিয়াম চালু
            await userDocRef.set({
                premiumPlan: true, 
                premiumExpiry: expiryTime,
                lastVerified: Date.now(),
                lastSubId: subscriptionId
            }, { merge: true });
            
            console.log(`✅ Success: Premium activated for ${userId}`);
            return res.status(200).json({ ok: true, active: true, expiryMillis: expiryTime });

        } else {
            // ব্যর্থ: মেয়াদ শেষ বা ক্যানসেল
            await userDocRef.set({ 
                premiumPlan: false,
                premiumExpiry: expiryTime
            }, { merge: true });
            
            console.log(`❌ Inactive: Subscription not valid for ${userId}`);
            return res.status(200).json({ ok: true, active: false, reason: 'Inactive or Expired' });
        }

    } catch (e) {
        // ৮. এরর হ্যান্ডলিং
        console.error("🔴 Server Error:", e.message);
        
        // Google API-এর বিস্তারিত এরর থাকলে লগ করা
        if (e.response && e.response.data) {
            console.error("Google API Details:", JSON.stringify(e.response.data));
        }
        
        return res.status(500).json({ error: e.message });
    }
};