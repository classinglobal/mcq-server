const { google } = require('googleapis');
const admin = require('firebase-admin');

module.exports = async (req, res) => {
    // ১. মেথড চেক
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        // ২. ডাটা পার্সিং
        let data = req.body;
        if (typeof data === 'string') {
            try {
                data = JSON.parse(data);
            } catch (e) {
                return res.status(400).json({ error: "Invalid JSON format" });
            }
        }

        const packageName = data.packageName;
        const token = data.token;
        const subscriptionId = data.subscriptionId;
        const userId = data.userId;

        // ৩. লগ চেক (Vercel-এ দেখার জন্য)
        console.log(`🔍 Processing for: ${userId} | Pkg: ${packageName} | Sub: ${subscriptionId}`);

        if (!packageName || !token || !subscriptionId || !userId) {
            console.error("🔴 Validation Failed: Missing fields");
            return res.status(400).json({ error: 'Missing required parameters' });
        }

        // ৪. চাবি লোড করা
        if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON || !process.env.PLAY_SERVICE_ACCOUNT_JSON) {
            throw new Error("SERVER_KEYS_MISSING");
        }

        const firebaseCreds = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
        const playCreds = JSON.parse(process.env.PLAY_SERVICE_ACCOUNT_JSON);

        // ৫. কানেকশন
        if (admin.apps.length === 0) {
            admin.initializeApp({ credential: admin.credential.cert(firebaseCreds) });
        }
        const db = admin.firestore();

        const auth = new google.auth.GoogleAuth({
            credentials: playCreds,
            scopes: ['https://www.googleapis.com/auth/androidpublisher'],
        });
        const androidpublisher = google.androidpublisher({ version: 'v3', auth });

        // ৬. ভেরিফিকেশন কল (✅ এখানে পরিবর্তন করা হয়েছে ✅)
        // আমরা v2 এর বদলে স্ট্যান্ডার্ড এবং স্ট্যাবল v1 মেথড ব্যবহার করছি
        // এটি সরাসরি প্যারামিটার গ্রহণ করে, তাই "Missing parameters" এরর দেবে না
        console.log("🔄 Calling Google API (Standard Method)...");
        
        const response = await androidpublisher.purchases.subscriptions.get({
            packageName: packageName,
            subscriptionId: subscriptionId,
            token: token
        });

        console.log("✅ Google API Response: Success");

        const subData = response.data;
        
        // ৭. স্ট্যাটাস এবং মেয়াদ চেক
        // Google Play v1 API সরাসরি expiryTimeMillis রিটার্ন করে
        const expiryMillis = subData.expiryTimeMillis;
        const expiryTime = expiryMillis ? Number(expiryMillis) : 0;
        
        // পেমেন্ট স্টেট চেক (null মানে কোনো পেমেন্ট নেই)
        // paymentState 1 = Payment Received, 0 = Pending/Trial (কিন্তু Active হতে পারে)
        // তাই আমরা শুধু মেয়াদ (Expiry) চেক করব, এটাই সবচেয়ে নির্ভরযোগ্য
        const isExpired = expiryTime <= Date.now();
        
        // ৮. ডাটাবেস আপডেট
        const userDocRef = db.collection('profile').doc(userId);

        if (!isExpired) {
            // মেয়াদ আছে = প্রিমিয়াম অ্যাক্টিভ
            await userDocRef.set({
                premiumPlan: true, 
                premiumExpiry: expiryTime,
                lastVerified: Date.now(),
                lastSubId: subscriptionId
            }, { merge: true });
            
            console.log(`🎉 Premium Activated for ${userId}`);
            return res.status(200).json({ ok: true, active: true, expiryMillis: expiryTime });

        } else {
            // মেয়াদ শেষ
            await userDocRef.set({ 
                premiumPlan: false,
                premiumExpiry: expiryTime
            }, { merge: true });
            
            console.log(`⛔ Expired subscription for ${userId}`);
            return res.status(200).json({ ok: true, active: false, reason: 'Expired' });
        }

    } catch (e) {
        console.error("🔴 SERVER ERROR:", e.message);
        if (e.response && e.response.data) {
            console.error("Google Error Details:", JSON.stringify(e.response.data));
        }
        return res.status(500).json({ error: e.message });
    }
};