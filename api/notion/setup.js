import { neon } from "@neondatabase/serverless";

const NOTION_VERSION = "2022-06-28";

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

function getPlainText(items = []) {
  return items
    .map((item) => item?.plain_text || "")
    .join("")
    .trim();
}

async function notion(
  accessToken,
  path,
  options = {}
) {
  const cleanPath = path.startsWith("/")
    ? path
    : `/${path}`;

  const url =
    `https://api.notion.com/v1${cleanPath}`;

  const response = await fetch(url, {
    ...options,

    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await response.text();

  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {
      raw: text,
    };
  }

  if (!response.ok) {
    throw new Error(
      `Notion ${response.status} sur ${url}: ` +
      `${JSON.stringify(data)}`
    );
  }

  return data;
}

async function getConnection(req) {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error(
      "Variable DATABASE_URL absente dans Vercel."
    );
  }

  const workspaceId = getCookie(
    req,
    "notion_workspace_id"
  );

  if (!workspaceId) {
    const error = new Error(
      "Aucun espace Notion connecté pour cette session."
    );

    error.statusCode = 401;

    throw error;
  }

  const sql = neon(databaseUrl);

  const rows = await sql`
    SELECT
      workspace_id,
      workspace_name,
      access_token
    FROM notion_connections
    WHERE workspace_id = ${workspaceId}
    LIMIT 1
  `;

  const connection = rows[0];

  if (!connection || !connection.access_token) {
    const error = new Error(
      "Connexion Notion introuvable ou expirée."
    );

    error.statusCode = 401;

    throw error;
  }

  return connection;
}

async function searchAllDatabases(accessToken) {
  const databases = [];

  let startCursor = undefined;
  let hasMore = true;

  while (hasMore) {
    const body = {
      filter: {
        property: "object",
        value: "database",
      },

      page_size: 100,
    };

    if (startCursor) {
      body.start_cursor = startCursor;
    }

    const result = await notion(
      accessToken,
      "/search",
      {
        method: "POST",
        body: JSON.stringify(body),
      }
    );

    databases.push(
      ...(result.results || [])
    );

    hasMore = Boolean(result.has_more);
    startCursor =
      result.next_cursor || undefined;
  }

  return databases;
}

export default async function handler(
  req,
  res
) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");

      return res
        .status(405)
        .send("Méthode non autorisée");
    }

    const connection =
      await getConnection(req);

    const databases =
      await searchAllDatabases(
        connection.access_token
      );

    const simplified = databases.map(
      (database) => ({
        id: database.id,

        title:
          getPlainText(database.title) ||
          "(Sans titre)",

        url:
          database.url || null,

        parent:
          database.parent || null,

        archived:
          Boolean(database.archived),

        in_trash:
          Boolean(database.in_trash),

        properties:
          Object.entries(
            database.properties || {}
          ).map(
            ([name, property]) => ({
              name,
              type:
                property?.type || null,
            })
          ),
      })
    );

    return res.status(200).json({
      ok: true,

      diagnostic: {
        workspace_id:
          connection.workspace_id,

        workspace_name:
          connection.workspace_name ||
          null,

        database_count:
          simplified.length,
      },

      databases: simplified,
    });
  } catch (error) {
    console.error(
      "Erreur setup Notion :",
      error
    );

    const statusCode =
      error.statusCode || 500;

    return res
      .status(statusCode)
      .json({
        ok: false,

        error:
          error.message ||
          "Erreur interne du serveur.",
      });
  }
}
