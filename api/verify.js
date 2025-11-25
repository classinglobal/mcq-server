const { google } = require('googleapis');
const admin = require('firebase-admin');

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        // 🔥 SUPER IMPORTANT: ALWAYS READ RAW BODY ON VERCEL
        let rawBody = '';

        await new Promise((resolve) => {
            req.on('data', chunk => rawBody += chunk);
            req.on('end', resolve);
        });

        let data;
        try {
            data = JSON.parse(rawBody);
        } catch (e) {
            console.error("JSON Parse Error:", e.message);
            return res.status(400).json({ error: "Invalid JSON from App" });
        }

        console.log("Received Body:", data);

        // 🔐 ENV Check
        if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON || !process.env.PLAY_SERVICE_ACCOUNT_JSON) {
            throw new Error("MISSING_SERVER_KEYS");
        }

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

        // 🟢 Extract params correctly
        const { packageName, token, subscriptionId, userId } = data;

        if (!packageName || !token || !subscriptionId || !userId) {
            console.error("Missing Fields:", data);
            return res.status(400).json({ error: 'Missing required parameters: packageName, token' });
        }

        // 🟢 Google Play API call
        const resp = await publisher.purchases.subscriptionsv2.get({
            name: `applications/${packageName}/purchases/subscriptionsv2/tokens/${token}`
        });

        const sub = resp.data;
        const expiryMillis =
            sub?.subscriptionPurchase?.expiryTimeMillis ||
            sub?.expiryTimeMillis || 0;

        const expiryTime = Number(expiryMillis);
        const isExpired = expiryTime <= Date.now();
        const isActive = sub.subscriptionState === 'SUBSCRIPTION_STATE_ACTIVE';

        const userRef = db.collection('profile').doc(userId);

        if (isActive && !isExpired) {
            await userRef.set({
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
            await userRef.set({
                premiumPlan: false,
                premiumExpiry: expiryTime
            }, { merge: true });

            return res.status(200).json({
                ok: true,
                active: false,
                reason: 'Inactive'
            });
        }

    } catch (e) {
        console.error("CRASH:", e.message);
        if (e.response?.data) console.error("Google API:", e.response.data);
        return res.status(500).json({ error: e.message });
    }
};
