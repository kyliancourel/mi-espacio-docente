export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).send("Méthode non autorisée");
  }

  const clientId = process.env.NOTION_CLIENT_ID;

  if (!clientId) {
    return res.status(500).json({
      ok: false,
      error: "Variable NOTION_CLIENT_ID absente dans Vercel.",
    });
  }

  const redirectUri =
    "https://mi-espacio-docente.vercel.app/api/notion/callback";

  const state = crypto.randomUUID();

  const authorizationUrl = new URL(
    "https://api.notion.com/v1/oauth/authorize"
  );

  authorizationUrl.searchParams.set("client_id", clientId);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("owner", "user");
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("state", state);

  res.setHeader(
    "Set-Cookie",
    `notion_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
  );

  return res.redirect(302, authorizationUrl.toString());
}
