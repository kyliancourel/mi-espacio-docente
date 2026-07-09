import { neon } from "@neondatabase/serverless";

const NOTION_VERSION = "2022-06-28";

const REQUIRED_DATABASES = {
  occurrences: {
    title: "📆 DB — Occurrences de cours",
    requiredProperties: {
      "📆 Cours prévu": "title",
      "📅 Date et heure": "date",
      "🏁 Fin": "date",
      "🎓 Classe": "relation",
      "📋 Feuilles d’appel": "relation",
    },
  },

  inscriptions: {
    title: "🎒 DB — Inscriptions élèves",
    requiredProperties: {
      "🎒 Inscription": "title",
      "🎓 Classe": "relation",
      "👨‍🎓 Élève": "relation",
      "👤 Présences": "relation",
    },
  },

  presences: {
    title: "👤 DB — Présences",
    requiredProperties: {
      "👤 Entrée de présence": "title",
      "🎒 Inscription élève": "relation",
      "✅ Statut de présence": "select",
      "📋 Feuille d’appel": "relation",
    },
  },

  feuillesAppel: {
    title: "📝 DB — Feuilles d’appel",
    requiredProperties: {
      "📝 Entrée d’appel": "title",
      "🎓 Classe": "relation",
      "👤 Présences": "relation",
      "📅 Occurrence de cours": "relation",
      "📅 Date et heure de l’appel": "date",
    },
  },
};

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
    const error = new Error(
      `Notion ${response.status} sur ${url}: ` +
      `${JSON.stringify(data)}`
    );

    error.statusCode = response.status;

    throw error;
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

  return {
    sql,
    connection,
  };
}

async function searchAllDatabases(accessToken) {
  const databases = [];

  let startCursor;
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

function getDatabaseTitle(database) {
  return (
    getPlainText(database?.title || []) ||
    "(Sans titre)"
  );
}

function validateDatabase(
  database,
  requiredProperties
) {
  const actualProperties =
    database?.properties || {};

  const missing = [];
  const wrongTypes = [];

  for (
    const [propertyName, expectedType]
    of Object.entries(requiredProperties)
  ) {
    const actualProperty =
      actualProperties[propertyName];

    if (!actualProperty) {
      missing.push(propertyName);
      continue;
    }

    if (actualProperty.type !== expectedType) {
      wrongTypes.push({
        property: propertyName,
        expected: expectedType,
        actual:
          actualProperty.type || null,
      });
    }
  }

  return {
    valid:
      missing.length === 0 &&
      wrongTypes.length === 0,

    missing,
    wrongTypes,
  };
}

function findDatabase(
  databases,
  definition
) {
  const exactTitleMatches =
    databases.filter(
      (database) =>
        getDatabaseTitle(database) ===
        definition.title
    );

  const evaluated =
    exactTitleMatches.map(
      (database) => ({
        database,
        validation: validateDatabase(
          database,
          definition.requiredProperties
        ),
      })
    );

  const validMatches =
    evaluated.filter(
      (item) => item.validation.valid
    );

  if (validMatches.length === 1) {
    return {
      status: "found",
      database:
        validMatches[0].database,
      validation:
        validMatches[0].validation,
    };
  }

  if (validMatches.length > 1) {
    return {
      status: "ambiguous",
      database: null,
      candidates:
        validMatches.map(
          (item) => ({
            id: item.database.id,
            title:
              getDatabaseTitle(
                item.database
              ),
            url:
              item.database.url || null,
          })
        ),
    };
  }

  if (exactTitleMatches.length > 0) {
    return {
      status: "invalid_structure",
      database: null,
      candidates:
        evaluated.map(
          (item) => ({
            id: item.database.id,
            title:
              getDatabaseTitle(
                item.database
              ),
            validation:
              item.validation,
          })
        ),
    };
  }

  return {
    status: "not_found",
    database: null,
  };
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

    const {
      sql,
      connection,
    } = await getConnection(req);

    const databases =
      await searchAllDatabases(
        connection.access_token
      );

    const detection = {};

    for (
      const [key, definition]
      of Object.entries(
        REQUIRED_DATABASES
      )
    ) {
      detection[key] = findDatabase(
        databases,
        definition
      );
    }

    const failures =
      Object.entries(detection)
        .filter(
          ([, result]) =>
            result.status !== "found"
        )
        .map(
          ([key, result]) => ({
            key,
            expected_title:
              REQUIRED_DATABASES[key].title,
            status:
              result.status,
            candidates:
              result.candidates || [],
          })
        );

    if (failures.length > 0) {
      return res.status(422).json({
        ok: false,

        error:
          "Installation automatique impossible : " +
          "certaines bases sont absentes, " +
          "ambiguës ou invalides.",

        diagnostic: {
          workspace_id:
            connection.workspace_id,

          workspace_name:
            connection.workspace_name ||
            null,

          database_count:
            databases.length,
        },

        failures,
      });
    }

    const occurrencesDb =
      detection.occurrences.database;

    const inscriptionsDb =
      detection.inscriptions.database;

    const presencesDb =
      detection.presences.database;

    const feuillesAppelDb =
      detection.feuillesAppel.database;

    await sql`
      INSERT INTO notion_workspace_config (
        workspace_id,
        occurrences_db_id,
        inscriptions_db_id,
        presences_db_id,
        feuilles_appel_db_id,
        updated_at
      )
      VALUES (
        ${connection.workspace_id},
        ${occurrencesDb.id},
        ${inscriptionsDb.id},
        ${presencesDb.id},
        ${feuillesAppelDb.id},
        NOW()
      )
      ON CONFLICT (workspace_id)
      DO UPDATE SET
        occurrences_db_id =
          EXCLUDED.occurrences_db_id,
        inscriptions_db_id =
          EXCLUDED.inscriptions_db_id,
        presences_db_id =
          EXCLUDED.presences_db_id,
        feuilles_appel_db_id =
          EXCLUDED.feuilles_appel_db_id,
        updated_at = NOW()
    `;

    return res.status(200).json({
      ok: true,

      message:
        "Installation automatique réussie.",

      workspace: {
        id:
          connection.workspace_id,

        name:
          connection.workspace_name ||
          null,
      },

      detected: {
        occurrences: {
          id:
            occurrencesDb.id,
          title:
            getDatabaseTitle(
              occurrencesDb
            ),
        },

        inscriptions: {
          id:
            inscriptionsDb.id,
          title:
            getDatabaseTitle(
              inscriptionsDb
            ),
        },

        presences: {
          id:
            presencesDb.id,
          title:
            getDatabaseTitle(
              presencesDb
            ),
        },

        feuilles_appel: {
          id:
            feuillesAppelDb.id,
          title:
            getDatabaseTitle(
              feuillesAppelDb
            ),
        },
      },

      saved_to_neon: true,
    });
  } catch (error) {
    console.error(
      "Erreur installation Notion :",
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
