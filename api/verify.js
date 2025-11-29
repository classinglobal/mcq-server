const { google } = require('googleapis');
const admin = require('firebase-admin');

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        // ----------- SUPER IMPORTANT -------------
        // Vercel never gives req.body
        // we must manually read raw body
        // -----------------------------------------
        let raw = '';
        await new Promise(resolve => {
            req.on('data', chunk => raw += chunk);
            req.on('end', resolve);
        });

        console.log("📥 RAW RECEIVED:", raw);

        let data;
        try {
            data = JSON.parse(raw);
        } catch (e) {
            console.error("JSON Parse Error:", e.message);
            return res.status(400).json({ error: "Invalid JSON" });
        }

        const { packageName, token, subscriptionId, userId } = data || {};

        if (!packageName || !token || !subscriptionId || !userId) {
            console.error("❌ MISSING PARAMS:", data);
            return res.status(400).json({
                error: 'Missing required parameters: packageName, token'
            });
        }

        // ENV
        const firebaseCreds = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
        const playCreds = JSON.parse(process.env.PLAY_SERVICE_ACCOUNT_JSON);

        if (admin.apps.length === 0) {
            admin.initializeApp({ credential: admin.credential.cert(firebaseCreds) });
        }

        const db = admin.firestore();

        const auth = new google.auth.GoogleAuth({
            credentials: playCreds,
            scopes: ['https://www.googleapis.com/auth/androidpublisher'],
        });

        const publisher = google.androidpublisher({ version: 'v3', auth });

        // Google Play Verification
        const response = await publisher.purchases.subscriptionsv2.get({
            name: `applications/${packageName}/purchases/subscriptionsv2/tokens/${token}`
        });

        const sub = response.data;
        const expiryMillis =
            sub?.subscriptionPurchase?.expiryTimeMillis ||
            sub?.expiryTimeMillis || 0;

        const expiryTime = Number(expiryMillis);
        const isExpired = expiryTime <= Date.now();
        const isActive = sub.subscriptionState === 'SUBSCRIPTION_STATE_ACTIVE';

        await db.collection('profile').doc(userId).set({
            premiumPlan: isActive && !isExpired,
            premiumExpiry: expiryTime,
            lastVerified: Date.now(),
            lastSubId: subscriptionId
        }, { merge: true });

        return res.status(200).json({
            ok: true,
            active: isActive && !isExpired,
            expiryMillis: expiryTime
        });

    } catch (e) {
        console.error("SERVER ERROR:", e.message);
        return res.status(500).json({ error: e.message });
    }
};
