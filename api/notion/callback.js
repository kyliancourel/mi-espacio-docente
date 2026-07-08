function getCookie(req, name) {
  const cookieHeader = req.headers.cookie || "";

  const cookies = cookieHeader.split(";").map((cookie) => cookie.trim());

  for (const cookie of cookies) {
    const separatorIndex = cookie.indexOf("=");

    if (separatorIndex === -1) continue;

    const key = cookie.slice(0, separatorIndex);
    const value = cookie.slice(separatorIndex + 1);

    if (key === name) {
      return decodeURIComponent(value);
    }
  }

  return null;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).send("Méthode non autorisée");
    }

    const code = req.query.code;
    const state = req.query.state;

    if (!code) {
      return res.status(400).json({
        ok: false,
        error: "Code OAuth Notion absent.",
      });
    }

    const savedState = getCookie(req, "notion_oauth_state");

    if (!state || !savedState || state !== savedState) {
      return res.status(400).json({
        ok: false,
        error: "État OAuth invalide ou expiré.",
      });
    }

    const clientId = process.env.NOTION_CLIENT_ID;
    const clientSecret = process.env.NOTION_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      throw new Error(
        "Variables NOTION_CLIENT_ID ou NOTION_CLIENT_SECRET absentes dans Vercel."
      );
    }

    const redirectUri =
      "https://mi-espacio-docente.vercel.app/api/notion/callback";

   const tokenResponse = await fetch(
  "https://api.notion.com/v1/oauth/token",
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Notion-Version": "2026-03-11",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId.trim(),
      client_secret: clientSecret.trim(),
    }),
  }
);

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok) {
      return res.status(tokenResponse.status).json({
        ok: false,
        error: "Échec de l'échange OAuth avec Notion.",
        details: tokenData,
      });
    }

    // Ne jamais afficher access_token dans la réponse
    const safeResult = {
      ok: true,
      message: "Connexion Notion réussie.",
      workspace_id: tokenData.workspace_id || null,
      workspace_name: tokenData.workspace_name || null,
      workspace_icon: tokenData.workspace_icon || null,
      bot_id: tokenData.bot_id || null,
      owner: tokenData.owner || null,
    };

    res.setHeader(
      "Set-Cookie",
      "notion_oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
    );

    return res.status(200).json(safeResult);
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
}
