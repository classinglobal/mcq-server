const { google } = require('googleapis');
const admin = require('firebase-admin');

module.exports = async (req, res) => {
    // ১. মেথড চেক
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        // ২. বডি পার্সিং (Body Parsing) - এটি খুবই গুরুত্বপূর্ণ
        // অনেক সময় Android থেকে ডাটা স্ট্রিং হিসেবে আসে
        let data = req.body;
        
        // ডিবাগিং লগ: ঠিক কী ডাটা এসেছে তা দেখার জন্য
        console.log("📥 Raw Body Type:", typeof data);
        if (typeof data === 'string') {
            try {
                data = JSON.parse(data);
                console.log("✅ Parsed JSON Body successfully");
            } catch (e) {
                console.error("❌ JSON Parse Error:", e.message);
                return res.status(400).json({ error: "Invalid JSON format sent from App" });
            }
        }

        // ৩. ডাটা ভেরিয়েবল
        const { packageName, token, subscriptionId, userId } = data || {};

        console.log(`🔍 Received: User=${userId}, Pkg=${packageName}, SubId=${subscriptionId}, TokenLength=${token ? token.length : 'MISSING'}`);

        // ৪. মিসিং প্যারামিটার চেক (সুনির্দিষ্ট এরর মেসেজ সহ)
        const missingFields = [];
        if (!packageName) missingFields.push('packageName');
        if (!token) missingFields.push('token');
        if (!subscriptionId) missingFields.push('subscriptionId');
        if (!userId) missingFields.push('userId');

        if (missingFields.length > 0) {
            console.error("🔴 Missing Fields:", missingFields.join(', '));
            return res.status(400).json({ 
                error: `Missing required parameters: ${missingFields.join(', ')}`,
                received: data 
            });
        }

        // ৫. চাবি (Keys) লোড করা (আপনার অনুরোধ অনুযায়ী আগের নিয়মে)
        let firebaseCreds, playCreds;
        try {
            if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is undefined");
            firebaseCreds = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
        } catch (e) {
            throw new Error(`Firebase Key Error: ${e.message}`);
        }

        try {
            if (!process.env.PLAY_SERVICE_ACCOUNT_JSON) throw new Error("PLAY_SERVICE_ACCOUNT_JSON is undefined");
            playCreds = JSON.parse(process.env.PLAY_SERVICE_ACCOUNT_JSON);
        } catch (e) {
            throw new Error(`Google Play Key Error: ${e.message}`);
        }

        // ৬. Firebase কানেকশন
        if (admin.apps.length === 0) {
            admin.initializeApp({
                credential: admin.credential.cert(firebaseCreds)
            });
        }
        const db = admin.firestore();

        // ৭. Google Play কানেকশন
        const auth = new google.auth.GoogleAuth({
            credentials: playCreds,
            scopes: ['https://www.googleapis.com/auth/androidpublisher'],
        });
        const androidpublisher = google.androidpublisher({ version: 'v3', auth });

        // ৮. ভেরিফিকেশন কল
        console.log("🔄 Calling Google Play API...");
        const response = await androidpublisher.purchases.subscriptionsv2.get({
            name: `applications/${packageName}/purchases/subscriptionsv2/tokens/${token}`
        });

        const subData = response.data;
        const expiryMillis = subData?.subscriptionPurchase?.expiryTimeMillis || subData?.expiryTimeMillis;
        const expiryTime = expiryMillis ? Number(expiryMillis) : 0;
        const isActiveSub = subData.subscriptionState === 'SUBSCRIPTION_STATE_ACTIVE';
        const isExpired = expiryTime <= Date.now();

        // ৯. Firestore আপডেট (profile কালেকশন)
        const userDocRef = db.collection('profile').doc(userId);

        if (isActiveSub && !isExpired) {
            await userDocRef.set({
                premiumPlan: true, 
                premiumExpiry: expiryTime,
                lastVerified: Date.now(),
                lastSubId: subscriptionId
            }, { merge: true });
            
            console.log(`✅ Success: Premium activated for ${userId}`);
            return res.status(200).json({ ok: true, active: true, expiryMillis: expiryTime });

        } else {
            await userDocRef.set({ 
                premiumPlan: false,
                premiumExpiry: expiryTime
            }, { merge: true });
            
            console.log(`❌ Inactive: Subscription not valid for ${userId}`);
            return res.status(200).json({ ok: true, active: false, reason: 'Inactive or Expired' });
        }

    } catch (e) {
        console.error("🔴 SERVER CRASH:", e.message);
        if (e.response && e.response.data) {
            console.error("Google API Error:", JSON.stringify(e.response.data));
        }
        return res.status(500).json({ error: e.message });
    }
};
