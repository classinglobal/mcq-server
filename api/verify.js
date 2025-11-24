const { google } = require('googleapis');
const admin = require('firebase-admin');

// --- কী (Key) লোড করার সেকশন ---
let firebaseCreds, playCreds;
try {
    firebaseCreds = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
} catch (e) {
    console.error("Firebase Key পার্স করা যায়নি। Environment Variable চেক করুন।", e.message);
}
try {
    playCreds = JSON.parse(process.env.PLAY_SERVICE_ACCOUNT_JSON);
} catch (e) {
    console.error("Google Play Key পার্স করা যায়নি। Environment Variable চেক করুন।", e.message);
}

// --- Firebase Admin SDK ইনিশিয়ালাইজ ---
if (admin.apps.length === 0 && firebaseCreds) {
    admin.initializeApp({
        credential: admin.credential.cert(firebaseCreds)
    });
}
const db = admin.firestore();

// --- Google Play API অথেন্টিকেশন ---
const auth = new google.auth.GoogleAuth({
    credentials: playCreds,
    scopes: ['https://www.googleapis.com/auth/androidpublisher'],
});
const androidpublisher = google.androidpublisher({
    version: 'v3',
    auth: auth,
});

// --- মূল সার্ভারলেস ফাংশন ---
module.exports = async (req, res) => {
    // শুধু POST রিকোয়েস্ট গ্রহণ করুন
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        // অ্যাপ থেকে পাঠানো তথ্য
        const { packageName, token, subscriptionId, userId } = req.body;

        if (!packageName || !token || !subscriptionId || !userId) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // ১. Google Play API কল করে ভেরিফাই করুন
        const response = await androidpublisher.purchases.subscriptionsv2.get({
            name: `applications/${packageName}/purchases/subscriptionsv2/tokens/${token}`
        });

        const subData = response.data;
        const expiryMillis = subData?.subscriptionPurchase?.expiryTimeMillis || subData?.expiryTimeMillis;
        const expiryTime = expiryMillis ? Number(expiryMillis) : 0;
        const isActiveSub = subData.subscriptionState === 'SUBSCRIPTION_STATE_ACTIVE';
        const isExpired = expiryTime <= Date.now();

        // আমরা "profile" কালেকশনে লিখব
        const userDocRef = db.collection('profile').doc(userId);

        if (isActiveSub && !isExpired) {
            // ২. সফল হলে: premiumPlan = true
            await userDocRef.set({
                premiumPlan: true, 
                premiumExpiry: expiryTime,
                lastVerified: Date.now(),
                lastSubId: subscriptionId
            }, { merge: true });
            
            return res.status(200).json({
                ok: true,
                active: true,
                expiryMillis: expiryTime
            });

        } else {
            // ৩. ব্যর্থ বা মেয়াদ শেষ হলে: premiumPlan = false
            await userDocRef.set({ 
                premiumPlan: false,
                premiumExpiry: expiryTime
            }, { merge: true });
            
            return res.status(200).json({
                ok: true,
                active: false,
                reason: `State: ${subData.subscriptionState}, Expired: ${isExpired}`
            });
        }
    } catch (e) {
        console.error('ভেরিফিকেশন ফেইল হয়েছে:', e.message);
        if (e.response && e.response.data) {
            return res.status(500).json({ error: 'Google API Error', details: e.response.data });
        }
        return res.status(500).json({ error: e.message });
    }
};