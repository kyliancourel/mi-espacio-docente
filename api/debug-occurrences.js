const NOTION_VERSION = "2022-06-28";

const OCCURRENCES_DB_ID = "39440bd7-969d-8096-b622-ee9c8ed30757";

function notionHeaders() {
  return {
    Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

async function notion(path, options = {}) {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  const url = `https://api.notion.com/v1${cleanPath}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      ...notionHeaders(),
      ...(options.headers || {}),
    },
  });

  const text = await response.text();

  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(
      `Notion ${response.status} sur ${url}: ${JSON.stringify(data)}`
    );
  }

  return data;
}

function simplifyProperty(prop) {
  if (!prop) return null;

  switch (prop.type) {
    case "title":
      return prop.title?.map((x) => x.plain_text).join("") || "";

    case "rich_text":
      return prop.rich_text?.map((x) => x.plain_text).join("") || "";

    case "date":
      return prop.date || null;

    case "relation":
      return prop.relation?.map((x) => x.id) || [];

    case "select":
      return prop.select?.name || null;

    case "status":
      return prop.status?.name || null;

    case "number":
      return prop.number;

    case "checkbox":
      return prop.checkbox;

    case "formula":
      return prop.formula || null;

    case "rollup":
      return prop.rollup || null;

    default:
      return {
        type: prop.type,
      };
  }
}

export default async function handler(req, res) {
  try {
    const now = new Date();

    const data = await notion(
      `/databases/${OCCURRENCES_DB_ID}/query`,
      {
        method: "POST",
        body: JSON.stringify({
          page_size: 20,
          sorts: [
            {
              timestamp: "last_edited_time",
              direction: "descending",
            },
          ],
        }),
      }
    );

    const occurrences = data.results.map((page) => {
      const properties = {};

      for (const [name, prop] of Object.entries(
        page.properties || {}
      )) {
        properties[name] = simplifyProperty(prop);
      }

      return {
        pageId: page.id,
        url: page.url,
        createdTime: page.created_time,
        lastEditedTime: page.last_edited_time,
        properties,
      };
    });

    return res.status(200).json({
      ok: true,
      diagnostic: {
        serverNowUTC: now.toISOString(),
        serverNowFrance: now.toLocaleString("fr-FR", {
          timeZone: "Europe/Paris",
        }),
        databaseId: OCCURRENCES_DB_ID,
        count: occurrences.length,
      },
      occurrences,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
}
