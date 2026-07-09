import { neon } from "@neondatabase/serverless";

const NOTION_VERSION = "2026-03-11";

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
      Authorization:
        `Bearer ${accessToken}`,

      "Notion-Version":
        NOTION_VERSION,

      "Content-Type":
        "application/json",

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
    const error = new Error(
      `Notion ${response.status} ` +
      `sur ${url}: ` +
      `${JSON.stringify(data)}`
    );

    error.statusCode = response.status;
    error.notionData = data;

    throw error;
  }

  return data;
}

async function getContext(req) {
  const databaseUrl =
    process.env.DATABASE_URL;

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
      "Aucun espace Notion connecté " +
      "pour cette session."
    );

    error.statusCode = 401;

    throw error;
  }

  const sql = neon(databaseUrl);

  const connectionRows = await sql`
    SELECT
      workspace_id,
      workspace_name,
      access_token
    FROM notion_connections
    WHERE workspace_id = ${workspaceId}
    LIMIT 1
  `;

  const connection = connectionRows[0];

  if (
    !connection ||
    !connection.access_token
  ) {
    const error = new Error(
      "Connexion Notion introuvable " +
      "ou expirée."
    );

    error.statusCode = 401;

    throw error;
  }

  const templateRows = await sql`
    SELECT
      template_key,
      component_key,
      notion_template_id,
      notion_data_source_id,
      notion_template_name,
      official_version,
      installed_version,
      sync_status,
      is_default
    FROM notion_workspace_templates
    WHERE workspace_id = ${workspaceId}
    ORDER BY template_key ASC
  `;

  if (templateRows.length === 0) {
    const error = new Error(
      "Aucun template officiel enregistré. " +
      "Lancez d'abord /api/notion/setup."
    );

    error.statusCode = 409;

    throw error;
  }

  return {
    connection,
    templates: templateRows,
  };
}

async function listAllBlockChildren(
  accessToken,
  blockId
) {
  const blocks = [];

  let startCursor;
  let hasMore = true;

  while (hasMore) {
    const params =
      new URLSearchParams();

    params.set("page_size", "100");

    if (startCursor) {
      params.set(
        "start_cursor",
        startCursor
      );
    }

    const result = await notion(
      accessToken,
      (
        `/blocks/${blockId}/children?` +
        params.toString()
      ),
      {
        method: "GET",
      }
    );

    blocks.push(
      ...(result.results || [])
    );

    hasMore =
      Boolean(result.has_more);

    startCursor =
      result.next_cursor ||
      undefined;
  }

  return blocks;
}

async function readBlockTree(
  accessToken,
  parentId,
  depth = 0,
  maxDepth = 10
) {
  const children =
    await listAllBlockChildren(
      accessToken,
      parentId
    );

  const result = [];

  for (const block of children) {
    const item = {
      id:
        block.id || null,

      type:
        block.type || null,

      has_children:
        Boolean(block.has_children),

      archived:
        Boolean(block.archived),

      in_trash:
        Boolean(block.in_trash),

      raw:
        block,
    };

    if (
      block.has_children &&
      depth < maxDepth
    ) {
      item.children =
        await readBlockTree(
          accessToken,
          block.id,
          depth + 1,
          maxDepth
        );
    }

    result.push(item);
  }

  return result;
}

function countBlocks(tree = []) {
  let total = 0;

  for (const block of tree) {
    total += 1;

    if (
      Array.isArray(block.children)
    ) {
      total += countBlocks(
        block.children
      );
    }
  }

  return total;
}

function collectBlockTypes(
  tree = [],
  counts = {}
) {
  for (const block of tree) {
    const type =
      block.type || "unknown";

    counts[type] =
      (counts[type] || 0) + 1;

    if (
      Array.isArray(block.children)
    ) {
      collectBlockTypes(
        block.children,
        counts
      );
    }
  }

  return counts;
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
      connection,
      templates,
    } = await getContext(req);

    const accessToken =
      connection.access_token;

    const results = {};
    const failures = [];

    for (const template of templates) {
      const templateKey =
        template.template_key;

      const templateId =
        template.notion_template_id;

      if (!templateId) {
        failures.push({
          template_key:
            templateKey,

          stage:
            "missing_template_id",

          error:
            "notion_template_id absent.",
        });

        continue;
      }

      try {
        /*
          Test 1 :
          le template peut-il être récupéré
          comme une page Notion ?
        */
        const page = await notion(
          accessToken,
          `/pages/${templateId}`,
          {
            method: "GET",
          }
        );

        /*
          Test 2 :
          les blocs enfants du template
          sont-ils accessibles ?
        */
        const blockTree =
          await readBlockTree(
            accessToken,
            templateId
          );

        results[templateKey] = {
          template_key:
            templateKey,

          component_key:
            template.component_key,

          template_name:
            template.notion_template_name,

          template_id:
            templateId,

          data_source_id:
            template.notion_data_source_id,

          official_version:
            template.official_version,

          installed_version:
            template.installed_version,

          sync_status:
            template.sync_status,

          page_readable:
            true,

          page_object:
            page.object || null,

          page_id:
            page.id || null,

          parent:
            page.parent || null,

          archived:
            Boolean(page.archived),

          in_trash:
            Boolean(page.in_trash),

          top_level_block_count:
            blockTree.length,

          recursive_block_count:
            countBlocks(blockTree),

          block_types:
            collectBlockTypes(
              blockTree
            ),

          block_tree:
            blockTree,
        };
      } catch (error) {
        failures.push({
          template_key:
            templateKey,

          template_id:
            templateId,

          stage:
            "read_template",

          error:
            error.message,

          notion_details:
            error.notionData || null,
        });

        results[templateKey] = {
          template_key:
            templateKey,

          template_id:
            templateId,

          page_readable:
            false,

          error:
            error.message,
        };
      }
    }

    const readableCount =
      Object.values(results)
        .filter(
          (result) =>
            result.page_readable === true
        )
        .length;

    const totalRecursiveBlocks =
      Object.values(results)
        .reduce(
          (total, result) =>
            total +
            (
              result.recursive_block_count ||
              0
            ),
          0
        );

    return res
      .status(200)
      .json({
        ok:
          failures.length === 0,

        message:
          failures.length === 0
            ? (
                "Lecture complète des templates " +
                "officiels réussie."
              )
            : (
                "Test terminé avec certaines " +
                "erreurs de lecture."
              ),

        notion_api_version:
          NOTION_VERSION,

        workspace: {
          id:
            connection.workspace_id,

          name:
            connection.workspace_name ||
            null,
        },

        summary: {
          registered_templates:
            templates.length,

          readable_templates:
            readableCount,

          total_recursive_blocks:
            totalRecursiveBlocks,

          failure_count:
            failures.length,
        },

        capability_test: {
          list_templates:
            true,

          retrieve_template_as_page:
            readableCount > 0,

          read_template_blocks:
            totalRecursiveBlocks > 0,

          create_template_object:
            "not_tested",

          update_template_object:
            "not_tested",

          clone_template_content:
            "not_tested",
        },

        results,

        failures,

        read_only:
          true,
      });
  } catch (error) {
    console.error(
      "Erreur test lecture templates :",
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
