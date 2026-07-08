import { neon } from "@neondatabase/serverless";

function getCookie(req, name) {
  const cookieHeader = req.headers.cookie || "";

  const cookies = cookieHeader
    .split(";")
    .map((cookie) => cookie.trim());

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
    // 1. Autoriser uniquement GET
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");

      return res
        .status(405)
        .send("Méthode non autorisée");
    }

    // 2. Récupérer les paramètres OAuth
    const code = req.query.code;
    const state = req.query.state;

    if (!code) {
      return res.status(400).json({
        ok: false,
        error: "Code OAuth Notion absent.",
      });
    }

    // 3. Vérifier le state OAuth
    const savedState = getCookie(
      req,
      "notion_oauth_state"
    );

    if (
      !state ||
      !savedState ||
      state !== savedState
    ) {
      return res.status(400).json({
        ok: false,
        error: "État OAuth invalide ou expiré.",
      });
    }

    // 4. Charger les variables Vercel
    const clientId =
      process.env.NOTION_CLIENT_ID;

    const clientSecret =
      process.env.NOTION_CLIENT_SECRET;

    const databaseUrl =
      process.env.DATABASE_URL;

    if (!clientId || !clientSecret) {
      throw new Error(
        "Variables NOTION_CLIENT_ID ou NOTION_CLIENT_SECRET absentes dans Vercel."
      );
    }

    if (!databaseUrl) {
      throw new Error(
        "Variable DATABASE_URL absente dans Vercel."
      );
    }

    // 5. URI OAuth officielle
    const redirectUri =
      "https://mi-espacio-docente.vercel.app/api/notion/callback";

    // 6. Authentification Basic requise
    // pour l'échange du code OAuth
    const basicAuth = Buffer.from(
      `${clientId.trim()}:${clientSecret.trim()}`
    ).toString("base64");

    // 7. Échanger le code OAuth
    // contre un access_token Notion
    const tokenResponse = await fetch(
      "https://api.notion.com/v1/oauth/token",
      {
        method: "POST",

        headers: {
          Authorization: `Basic ${basicAuth}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },

        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
        }),
      }
    );

    const tokenData =
      await tokenResponse.json();

    // 8. Vérifier la réponse Notion
    if (!tokenResponse.ok) {
      return res
        .status(tokenResponse.status)
        .json({
          ok: false,
          error:
            "Échec de l'échange OAuth avec Notion.",
          details: tokenData,
        });
    }

    if (
      !tokenData.access_token ||
      !tokenData.workspace_id
    ) {
      throw new Error(
        "Réponse OAuth Notion incomplète : access_token ou workspace_id absent."
      );
    }

    // 9. Connexion à Neon
    const sql = neon(databaseUrl);

    // 10. Informations du propriétaire
    const ownerUser =
      tokenData.owner?.user || null;

    // 11. Enregistrer ou mettre à jour
    // la connexion Notion dans Neon
    await sql`
      INSERT INTO notion_connections (
        workspace_id,
        workspace_name,
        workspace_icon,
        bot_id,
        owner_user_id,
        owner_name,
        owner_email,
        access_token,
        updated_at
      )
      VALUES (
        ${tokenData.workspace_id},
        ${tokenData.workspace_name || null},
        ${tokenData.workspace_icon || null},
        ${tokenData.bot_id || null},
        ${ownerUser?.id || null},
        ${ownerUser?.name || null},
        ${ownerUser?.person?.email || null},
        ${tokenData.access_token},
        NOW()
      )
      ON CONFLICT (workspace_id)
      DO UPDATE SET
        workspace_name = EXCLUDED.workspace_name,
        workspace_icon = EXCLUDED.workspace_icon,
        bot_id = EXCLUDED.bot_id,
        owner_user_id = EXCLUDED.owner_user_id,
        owner_name = EXCLUDED.owner_name,
        owner_email = EXCLUDED.owner_email,
        access_token = EXCLUDED.access_token,
        updated_at = NOW()
    `;

    // 12. Cookies
    //
    // - Supprimer le state OAuth temporaire
    // - Enregistrer l'espace Notion connecté
    //
    // Le cookie workspace est HttpOnly :
    // JavaScript côté navigateur ne peut pas le lire.
    res.setHeader("Set-Cookie", [
      [
        "notion_oauth_state=",
        "Path=/",
        "HttpOnly",
        "Secure",
        "SameSite=Lax",
        "Max-Age=0",
      ].join("; "),

      [
        `notion_workspace_id=${encodeURIComponent(
          tokenData.workspace_id
        )}`,
        "Path=/",
        "HttpOnly",
        "Secure",
        "SameSite=Lax",
        "Max-Age=2592000",
      ].join("; "),
    ]);

    // 13. Réponse de succès
    //
    // L'access_token n'est volontairement
    // jamais renvoyé au navigateur.
    return res.status(200).json({
      ok: true,
      message:
        "Connexion Notion réussie et enregistrée.",

      workspace_id:
        tokenData.workspace_id,

      workspace_name:
        tokenData.workspace_name || null,
    });
  } catch (error) {
    console.error(
      "Erreur callback Notion :",
      error
    );

    return res.status(500).json({
      ok: false,
      error:
        error.message ||
        "Erreur interne du serveur.",
    });
  }
}
