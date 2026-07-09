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

async function getNotionContext(req) {
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
      c.workspace_id,
      c.workspace_name,
      c.workspace_icon,
      c.access_token,

      cfg.occurrences_db_id,
      cfg.inscriptions_db_id,
      cfg.presences_db_id,
      cfg.feuilles_appel_db_id,
      cfg.feuille_template_id

    FROM notion_connections AS c

    LEFT JOIN notion_workspace_config AS cfg
      ON cfg.workspace_id = c.workspace_id

    WHERE c.workspace_id = ${workspaceId}

    LIMIT 1
  `;

  const context = rows[0];

  if (!context || !context.access_token) {
    const error = new Error(
      "Connexion Notion introuvable ou expirée."
    );

    error.statusCode = 401;

    throw error;
  }

  const missingConfig = [];

  if (!context.occurrences_db_id) {
    missingConfig.push("occurrences_db_id");
  }

  if (!context.inscriptions_db_id) {
    missingConfig.push("inscriptions_db_id");
  }

  if (!context.presences_db_id) {
    missingConfig.push("presences_db_id");
  }

  if (!context.feuilles_appel_db_id) {
    missingConfig.push("feuilles_appel_db_id");
  }

  if (!context.feuille_template_id) {
    missingConfig.push("feuille_template_id");
  }

  if (missingConfig.length > 0) {
    const error = new Error(
      "Configuration Mi Espacio Docente incomplète pour cet espace Notion : " +
      missingConfig.join(", ")
    );

    error.statusCode = 409;

    throw error;
  }

  return {
    workspaceId: context.workspace_id,

    workspaceName:
      context.workspace_name || null,

    workspaceIcon:
      context.workspace_icon || null,

    accessToken:
      context.access_token,

    ids: {
      occurrencesDb:
        context.occurrences_db_id,

      inscriptionsDb:
        context.inscriptions_db_id,

      presencesDb:
        context.presences_db_id,

      feuillesAppelDb:
        context.feuilles_appel_db_id,

      feuilleTemplate:
        context.feuille_template_id,
    },
  };
}

function notionHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
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
      ...notionHeaders(accessToken),
      ...(options.headers || {}),
    },
  });

  const text = await response.text();

  let data;

  try {
    data = text
      ? JSON.parse(text)
      : {};
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

function notionPageUrl(pageId) {
  return (
    `https://www.notion.so/` +
    pageId.replace(/-/g, "")
  );
}

function htmlRedirect(url) {
  const safeUrl = JSON.stringify(url);

  const escapedHref = String(url)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">

  <meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
  >

  <meta
    http-equiv="refresh"
    content="0;url=${escapedHref}"
  >

  <title>
    Ouverture de la feuille d'appel
  </title>

  <script>
    window.location.replace(${safeUrl});
  </script>
</head>

<body>
  <p>
    Ouverture de la feuille d'appel...
  </p>

  <p>
    <a href="${escapedHref}">
      Cliquez ici si la redirection ne démarre pas.
    </a>
  </p>
</body>
</html>`;
}

function redirectToPage(res, pageOrId) {
  const url =
    typeof pageOrId === "string"
      ? notionPageUrl(pageOrId)
      : (
          pageOrId.url ||
          notionPageUrl(pageOrId.id)
        );

  res.setHeader(
    "Content-Type",
    "text/html; charset=utf-8"
  );

  res.setHeader(
    "Cache-Control",
    "no-store"
  );

  return res
    .status(200)
    .send(htmlRedirect(url));
}

function getRelationIds(page, propertyName) {
  const property =
    page?.properties?.[propertyName];

  if (
    !property ||
    property.type !== "relation"
  ) {
    return [];
  }

  return (property.relation || [])
    .map((item) => item.id)
    .filter(Boolean);
}

function getTitle(page, propertyName) {
  const property =
    page?.properties?.[propertyName];

  if (
    !property ||
    property.type !== "title"
  ) {
    return "";
  }

  return (property.title || [])
    .map((item) => item.plain_text || "")
    .join("");
}

function getPageTitle(page) {
  for (
    const property of Object.values(
      page?.properties || {}
    )
  ) {
    if (property?.type === "title") {
      return (property.title || [])
        .map(
          (item) =>
            item.plain_text || ""
        )
        .join("");
    }
  }

  return "Classe";
}

function formatParisDate(date) {
  return new Intl.DateTimeFormat(
    "fr-FR",
    {
      timeZone: "Europe/Paris",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }
  ).format(date);
}

function formatParisTime(date) {
  return new Intl.DateTimeFormat(
    "fr-FR",
    {
      timeZone: "Europe/Paris",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }
  ).format(date);
}

async function findExistingSheet(
  accessToken,
  ids,
  occurrence
) {
  // Contrôle 1 :
  // relation directe depuis l'occurrence
  const linkedSheetIds = getRelationIds(
    occurrence,
    "📋 Feuilles d’appel"
  );

  if (linkedSheetIds.length > 0) {
    const sheet = await notion(
      accessToken,
      `/pages/${linkedSheetIds[0]}`,
      {
        method: "GET",
      }
    );

    if (
      !sheet.archived &&
      !sheet.in_trash
    ) {
      return sheet;
    }
  }

  // Contrôle 2 :
  // recherche inverse dans la DB
  const result = await notion(
    accessToken,
    `/databases/${ids.feuillesAppelDb}/query`,
    {
      method: "POST",

      body: JSON.stringify({
        filter: {
          property:
            "📅 Occurrence de cours",

          relation: {
            contains: occurrence.id,
          },
        },

        page_size: 10,
      }),
    }
  );

  return (
    (result.results || []).find(
      (page) =>
        !page.archived &&
        !page.in_trash
    ) || null
  );
}

export default async function handler(
  req,
  res
) {
  try {
    // 1. Autoriser uniquement GET
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");

      return res
        .status(405)
        .send("Méthode non autorisée");
    }

    // 2. Charger le contexte complet :
    // token OAuth + configuration du workspace
    const context =
      await getNotionContext(req);

    const accessToken =
      context.accessToken;

    const ids =
      context.ids;

    const now = new Date();
    const nowIso = now.toISOString();

    // 3. Trouver le cours en cours
    const occurrenceResult = await notion(
      accessToken,
      `/databases/${ids.occurrencesDb}/query`,
      {
        method: "POST",

        body: JSON.stringify({
          filter: {
            and: [
              {
                property:
                  "📅 Date et heure",

                date: {
                  on_or_before: nowIso,
                },
              },

              {
                property: "🏁 Fin",

                date: {
                  on_or_after: nowIso,
                },
              },
            ],
          },

          page_size: 10,
        }),
      }
    );

    const occurrence =
      occurrenceResult.results?.[0];

    if (!occurrence) {
      return res
        .status(404)
        .send(
          "Aucun cours en cours n'a été trouvé."
        );
    }

    // 4. Vérifier si une feuille
    // existe déjà
    const existingSheet =
      await findExistingSheet(
        accessToken,
        ids,
        occurrence
      );

    if (existingSheet) {
      return redirectToPage(
        res,
        existingSheet
      );
    }

    // 5. Récupérer la classe
    const classeIds = getRelationIds(
      occurrence,
      "🎓 Classe"
    );

    const classeId = classeIds[0];

    if (!classeId) {
      throw new Error(
        "L'occurrence en cours ne contient " +
        "aucune relation « 🎓 Classe »."
      );
    }

    const classe = await notion(
      accessToken,
      `/pages/${classeId}`,
      {
        method: "GET",
      }
    );

    const classeNom =
      getPageTitle(classe) || "Classe";

    // 6. Trouver les inscriptions
    // de la classe
    const inscriptionsResult =
      await notion(
        accessToken,
        `/databases/${ids.inscriptionsDb}/query`,
        {
          method: "POST",

          body: JSON.stringify({
            filter: {
              property: "🎓 Classe",

              relation: {
                contains: classeId,
              },
            },

            page_size: 100,
          }),
        }
      );

    const inscriptions =
      inscriptionsResult.results || [];

    if (inscriptions.length === 0) {
      throw new Error(
        `Aucune inscription trouvée ` +
        `pour la classe « ${classeNom} ».`
      );
    }

    // 7. Recontrôle avant création
    const sheetAfterLookup =
      await findExistingSheet(
        accessToken,
        ids,
        occurrence
      );

    if (sheetAfterLookup) {
      return redirectToPage(
        res,
        sheetAfterLookup
      );
    }

    // 8. Préparer le titre
    const titreAppel =
      `APPEL - ${classeNom} - ` +
      `${formatParisDate(now)} - ` +
      `${formatParisTime(now)}`;

    // 9. Créer d'abord la feuille
    // sans présences
    const feuille = await notion(
      accessToken,
      "/pages",
      {
        method: "POST",

        body: JSON.stringify({
          parent: {
            database_id:
              ids.feuillesAppelDb,
          },

          template: {
            type: "template_id",
            template_id:
              ids.feuilleTemplate,
            timezone: "Europe/Paris",
          },

          properties: {
            "📝 Entrée d’appel": {
              title: [
                {
                  text: {
                    content: titreAppel,
                  },
                },
              ],
            },

            "🎓 Classe": {
              relation: [
                {
                  id: classeId,
                },
              ],
            },

            "📅 Occurrence de cours": {
              relation: [
                {
                  id: occurrence.id,
                },
              ],
            },

            "📅 Date et heure de l’appel": {
              date: {
                start: nowIso,
              },
            },
          },
        }),
      }
    );

    // 10. Créer une présence neuve
    // pour chaque inscription
    const presenceIds = [];

    for (const inscription of inscriptions) {
      const nomInscription =
        getTitle(
          inscription,
          "🎒 Inscription"
        ) || "Élève";

      const presence = await notion(
        accessToken,
        "/pages",
        {
          method: "POST",

          body: JSON.stringify({
            parent: {
              database_id:
                ids.presencesDb,
            },

            properties: {
              "👤 Entrée de présence": {
                title: [
                  {
                    text: {
                      content:
                        nomInscription,
                    },
                  },
                ],
              },

              "🎒 Inscription élève": {
                relation: [
                  {
                    id: inscription.id,
                  },
                ],
              },

              "✅ Statut de présence": {
                select: {
                  name:
                    "🟢 Présent(e)",
                },
              },
            },
          }),
        }
      );

      presenceIds.push(presence.id);
    }

    // 11. Rattacher toutes les nouvelles
    // présences à la feuille créée
    await notion(
      accessToken,
      `/pages/${feuille.id}`,
      {
        method: "PATCH",

        body: JSON.stringify({
          properties: {
            "👤 Présences": {
              relation:
                presenceIds.map(
                  (id) => ({
                    id,
                  })
                ),
            },
          },
        }),
      }
    );

    // 12. Récupérer la feuille mise à jour
    const updatedFeuille = await notion(
      accessToken,
      `/pages/${feuille.id}`,
      {
        method: "GET",
      }
    );

    // 13. Ouvrir la feuille
    return redirectToPage(
      res,
      updatedFeuille
    );
  } catch (error) {
    console.error(
      "Erreur Faire l'appel :",
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
