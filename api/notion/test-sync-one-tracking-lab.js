import { neon } from "@neondatabase/serverless";

import {
  NOTION_VERSION,
  getCookie,
  notion,
  listAllTemplates,
  findTemplateById,
  readBlockTree,
  calculateFingerprint,
  buildSnapshot,
  validateSyncCandidate,
  applyTemplateNatively,
  waitForStableFingerprint,
} from "./sync-one.js";

const OFFICIAL_TEMPLATE_KEY = "class_dashboard";

const LAB_TEMPLATE_KEY =
  "__lab_sync_tracking_class_dashboard__";

const LAB_TEMPLATE_NAME =
  "🧪 TEMPLATE LABORATOIRE — FULL SYNC TEST";

function normalizeId(value) {
  return String(value || "")
    .replace(/-/g, "")
    .toLowerCase()
    .trim();
}

export default async function handler(req, res) {
  let sql = null;
  let workspaceId = null;
  let labRowCreated = false;
  let notionWriteOperations = 0;
  let neonWriteOperations = 0;

  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");

      return res.status(405).json({
        ok: false,
        error: "Méthode non autorisée",
      });
    }

    const databaseUrl = process.env.DATABASE_URL;

    if (!databaseUrl) {
      throw new Error(
        "Variable DATABASE_URL absente dans Vercel."
      );
    }

    workspaceId = getCookie(
      req,
      "notion_workspace_id"
    );

    if (!workspaceId) {
      return res.status(401).json({
        ok: false,
        engine_stage: "2/6",
        error:
          "Aucun espace Notion connecté pour cette session.",
      });
    }

    sql = neon(databaseUrl);

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

    if (!connection?.access_token) {
      return res.status(401).json({
        ok: false,
        engine_stage: "2/6",
        error:
          "Connexion Notion introuvable ou expirée.",
      });
    }

    const officialRows = await sql`
      SELECT
        id,
        template_key,
        component_key,
        notion_template_name,
        master_workspace_id,
        master_notion_template_id,
        master_notion_data_source_id,
        official_version,
        official_fingerprint,
        is_active,
        propagate_existing_installations,
        update_if_outdated,
        overwrite_local_changes,
        local_changes_policy
      FROM notion_official_templates
      WHERE template_key =
        ${OFFICIAL_TEMPLATE_KEY}
      LIMIT 1
    `;

    const official = officialRows[0];

    if (!official) {
      return res.status(409).json({
        ok: false,
        engine_stage: "2/6",
        status:
          "official_template_not_registered",
        error:
          "Le template officiel class_dashboard est introuvable.",
      });
    }

    if (!official.is_active) {
      return res.status(409).json({
        ok: false,
        engine_stage: "2/6",
        status: "official_template_inactive",
        error:
          "Le template officiel class_dashboard est désactivé.",
      });
    }

    if (
      !official.master_notion_template_id ||
      !official.master_notion_data_source_id ||
      !official.official_fingerprint
    ) {
      return res.status(409).json({
        ok: false,
        engine_stage: "2/6",
        status:
          "official_reference_incomplete",
        error:
          "La référence officielle centrale est incomplète.",
      });
    }

    if (
      official.master_workspace_id &&
      official.master_workspace_id !==
        connection.workspace_id
    ) {
      return res.status(409).json({
        ok: false,
        engine_stage: "2/6",
        status:
          "wrong_workspace_for_lab_test",
        error:
          "Le test laboratoire est refusé hors du workspace maître.",
      });
    }

    const accessToken =
      connection.access_token;

    const templates = await listAllTemplates(
      accessToken,
      official.master_notion_data_source_id
    );

    const masterTemplate = findTemplateById(
      templates,
      official.master_notion_template_id
    );

    if (!masterTemplate) {
      return res.status(409).json({
        ok: false,
        engine_stage: "2/6",
        status:
          "master_template_not_detected",
        error:
          "Le template maître officiel n'est plus détecté.",
      });
    }

    const labMatches = templates.filter(
      (template) =>
        String(template?.name || "").trim() ===
        LAB_TEMPLATE_NAME
    );

    if (labMatches.length === 0) {
      return res.status(409).json({
        ok: false,
        engine_stage: "2/6",
        status: "lab_template_missing",
        error:
          `Template laboratoire introuvable : ${LAB_TEMPLATE_NAME}`,
      });
    }

    if (labMatches.length > 1) {
      return res.status(409).json({
        ok: false,
        engine_stage: "2/6",
        status: "ambiguous_lab_template",
        error:
          "Plusieurs templates laboratoire portent exactement le même nom.",
        match_count: labMatches.length,
      });
    }

    const labTemplate = labMatches[0];

    if (
      normalizeId(labTemplate.id) ===
      normalizeId(masterTemplate.id)
    ) {
      return res.status(409).json({
        ok: false,
        engine_stage: "2/6",
        status: "lab_target_is_master",
        error:
          "La cible laboratoire correspond au master officiel. Test refusé.",
      });
    }

    await notion(
      accessToken,
      `/pages/${masterTemplate.id}`,
      { method: "GET" }
    );

    await notion(
      accessToken,
      `/pages/${labTemplate.id}`,
      { method: "GET" }
    );

    const masterTree = await readBlockTree(
      accessToken,
      masterTemplate.id
    );

    const masterFingerprint =
      calculateFingerprint(masterTree);

    if (
      masterFingerprint !==
      official.official_fingerprint
    ) {
      return res.status(409).json({
        ok: false,
        engine_stage: "2/6",
        status: "master_registry_drift",
        error:
          "Le master réel ne correspond plus au fingerprint officiel enregistré.",

        safety: {
          notion_write_operations: 0,
          neon_write_operations: 0,
        },
      });
    }

    /*
      On force d'abord la cible laboratoire
      dans un état réel différent du master.

      Pour cela, on supprime uniquement son
      contenu en appliquant le même mécanisme
      natif sur une cible déjà sacrificielle
      n'est pas suffisant : si elle est déjà
      identique au master, il faut une baseline
      antérieure distincte.

      Le test refuse donc de continuer si le
      laboratoire est déjà identique au master.
    */
    const labBeforeTree = await readBlockTree(
      accessToken,
      labTemplate.id
    );

    const labBeforeFingerprint =
      calculateFingerprint(labBeforeTree);

    const labBeforeSnapshot =
      buildSnapshot(labBeforeTree);

    if (
      labBeforeFingerprint ===
      official.official_fingerprint
    ) {
      return res.status(409).json({
        ok: false,
        engine_stage: "2/6",
        status:
          "lab_already_matches_official",
        error:
          "Le template laboratoire correspond déjà au master officiel. Il faut d'abord lui donner un contenu différent pour tester un vrai update_available.",

        laboratory_target: {
          template_id: labTemplate.id,
          fingerprint:
            labBeforeFingerprint,
          snapshot:
            labBeforeSnapshot,
        },

        safety: {
          notion_write_operations: 0,
          neon_write_operations: 0,
          lab_tracking_created: false,
        },
      });
    }

    /*
      Nettoyage préventif :
      aucune ancienne ligne de test ne doit
      survivre à une exécution précédente.
    */
    await sql`
      DELETE FROM notion_workspace_templates
      WHERE workspace_id = ${workspaceId}
        AND template_key = ${LAB_TEMPLATE_KEY}
    `;

    neonWriteOperations += 1;

    /*
      Création d'une installation locale
      laboratoire réellement obsolète.

      Version installée : 0.9.0
      Version officielle : 1.0.0
      Baseline locale : contenu réel actuel
      de la cible laboratoire.
    */
    const insertedRows = await sql`
      INSERT INTO notion_workspace_templates (
        workspace_id,
        template_key,
        component_key,
        notion_template_id,
        notion_data_source_id,
        notion_template_name,
        official_version,
        installed_version,
        official_fingerprint,
        local_fingerprint,
        sync_status,
        is_default,
        locally_modified,
        conflict_detected,
        last_detected_at,
        created_at,
        updated_at
      )
      VALUES (
        ${workspaceId},
        ${LAB_TEMPLATE_KEY},
        ${official.component_key},
        ${labTemplate.id},
        ${official.master_notion_data_source_id},
        ${LAB_TEMPLATE_NAME},
        ${official.official_version},
        '0.9.0',
        ${official.official_fingerprint},
        ${labBeforeFingerprint},
        'outdated',
        false,
        false,
        false,
        now(),
        now(),
        now()
      )
      RETURNING
        id,
        workspace_id,
        template_key,
        component_key,
        notion_template_id,
        installed_version,
        local_fingerprint,
        sync_status
    `;

    neonWriteOperations += 1;
    labRowCreated = true;

    const local = insertedRows[0];

    if (!local) {
      throw new Error(
        "Impossible de créer la ligne de tracking laboratoire."
      );
    }

    /*
      Validation avec la vraie fonction
      du moteur sync-one.js.
    */
    const validation =
      validateSyncCandidate({
        local,
        official,
        currentFingerprint:
          labBeforeFingerprint,
      });

    if (!validation.allowed) {
      return res.status(409).json({
        ok: false,
        engine_stage: "2/6",
        status:
          "lab_candidate_validation_failed",
        error:
          "La vraie validation du moteur a refusé le scénario laboratoire.",

        validation,

        tracking_before: local,

        safety: {
          notion_write_operations:
            notionWriteOperations,
          neon_write_operations:
            neonWriteOperations,
        },
      });
    }

    /*
      Revalidation concurrente juste avant
      l'écriture Notion.
    */
    const preWriteTree = await readBlockTree(
      accessToken,
      labTemplate.id
    );

    const preWriteFingerprint =
      calculateFingerprint(preWriteTree);

    if (
      preWriteFingerprint !==
      labBeforeFingerprint
    ) {
      return res.status(409).json({
        ok: false,
        engine_stage: "2/6",
        status:
          "concurrent_lab_change",
        error:
          "Le template laboratoire a changé pendant la préparation.",
      });
    }

    /*
      Synchronisation native réelle.
    */
    const nativeApplyResponse =
      await applyTemplateNatively({
        accessToken,
        targetTemplateId:
          labTemplate.id,
        sourceTemplateId:
          masterTemplate.id,
      });

    notionWriteOperations += 1;

    /*
      Vérification réelle du fingerprint final.
    */
    const stabilization =
      await waitForStableFingerprint({
        accessToken,
        templateId:
          labTemplate.id,
        expectedFingerprint:
          official.official_fingerprint,
      });

    if (!stabilization.stable) {
      return res.status(500).json({
        ok: false,
        engine_stage: "2/6",
        status:
          "native_sync_verification_failed",

        error:
          "Le PATCH natif a été accepté, mais le fingerprint final officiel n'a pas été confirmé.",

        stabilization,

        safety: {
          notion_write_operations:
            notionWriteOperations,
          neon_write_operations:
            neonWriteOperations,
          tracking_updated: false,
        },
      });
    }

    /*
      Mise à jour Neon uniquement après
      preuve du fingerprint officiel.
    */
    const updatedRows = await sql`
      UPDATE notion_workspace_templates
      SET
        installed_version =
          ${official.official_version},

        official_version =
          ${official.official_version},

        official_fingerprint =
          ${official.official_fingerprint},

        local_fingerprint =
          ${official.official_fingerprint},

        sync_status = 'current',

        locally_modified = false,

        conflict_detected = false,

        last_detected_at = now(),

        last_synced_at = now(),

        updated_at = now()

      WHERE workspace_id =
        ${workspaceId}

        AND template_key =
          ${LAB_TEMPLATE_KEY}

      RETURNING
        id,
        workspace_id,
        template_key,
        component_key,
        notion_template_id,
        installed_version,
        official_version,
        official_fingerprint,
        local_fingerprint,
        sync_status,
        locally_modified,
        conflict_detected,
        last_detected_at,
        last_synced_at
    `;

    neonWriteOperations += 1;

    const updatedTracking =
      updatedRows[0] || null;

    if (!updatedTracking) {
      return res.status(500).json({
        ok: false,
        engine_stage: "2/6",
        status:
          "tracking_update_failed_after_native_sync",
        error:
          "La synchronisation Notion est vérifiée, mais le tracking laboratoire n'a pas été mis à jour.",
      });
    }

    /*
      Preuve finale :
      relecture de la ligne réellement écrite.
    */
    const finalRows = await sql`
      SELECT
        id,
        workspace_id,
        template_key,
        component_key,
        notion_template_id,
        installed_version,
        official_version,
        official_fingerprint,
        local_fingerprint,
        sync_status,
        locally_modified,
        conflict_detected,
        last_detected_at,
        last_synced_at
      FROM notion_workspace_templates
      WHERE workspace_id = ${workspaceId}
        AND template_key = ${LAB_TEMPLATE_KEY}
      LIMIT 1
    `;

    const finalTracking =
      finalRows[0] || null;

    const trackingVerified =
      Boolean(
        finalTracking &&
        finalTracking.installed_version ===
          official.official_version &&
        finalTracking.official_fingerprint ===
          official.official_fingerprint &&
        finalTracking.local_fingerprint ===
          official.official_fingerprint &&
        finalTracking.sync_status ===
          "current" &&
        finalTracking.locally_modified ===
          false &&
        finalTracking.conflict_detected ===
          false
      );

    if (!trackingVerified) {
      return res.status(500).json({
        ok: false,
        engine_stage: "2/6",
        status:
          "final_tracking_verification_failed",
        error:
          "La relecture finale Neon ne confirme pas l'état attendu.",

        final_tracking:
          finalTracking,
      });
    }

    /*
      Nettoyage de la ligne laboratoire.
      Le template laboratoire reste sacrificiel,
      mais aucune fausse installation locale
      ne doit rester dans le registre.
    */
    await sql`
      DELETE FROM notion_workspace_templates
      WHERE workspace_id = ${workspaceId}
        AND template_key = ${LAB_TEMPLATE_KEY}
    `;

    neonWriteOperations += 1;
    labRowCreated = false;

    return res.status(200).json({
      ok: true,

      message:
        "Test complet update_available → synchronisation native → vérification fingerprint → mise à jour Neon réussi.",

      engine_stage: "2/6",
      test:
        "real_update_available_tracking_lab",
      notion_api_version:
        NOTION_VERSION,

      workspace: {
        id: connection.workspace_id,
        name:
          connection.workspace_name || null,
      },

      master: {
        template_key:
          official.template_key,
        template_id:
          masterTemplate.id,
        official_version:
          official.official_version,
        official_fingerprint:
          official.official_fingerprint,
      },

      laboratory_target: {
        name:
          labTemplate.name,
        template_id:
          labTemplate.id,

        before: {
          installed_version: "0.9.0",
          fingerprint:
            labBeforeFingerprint,
          snapshot:
            labBeforeSnapshot,
        },

        after: {
          installed_version:
            official.official_version,
          fingerprint:
            stabilization.fingerprint,
          snapshot:
            stabilization.snapshot,
        },
      },

      validation,

      native_apply: {
        accepted: true,
        erase_content: true,
        response_id:
          nativeApplyResponse?.id || null,
      },

      stabilization,

      tracking: {
        before: local,
        after_update:
          updatedTracking,
        final_verified_state:
          finalTracking,
        verified:
          trackingVerified,
        laboratory_row_cleaned:
          true,
      },

      verification: {
        candidate_was_update_available:
          validation.allowed === true &&
          validation.status ===
            "update_available",

        final_matches_official:
          stabilization.fingerprint ===
          official.official_fingerprint,

        neon_tracking_verified:
          trackingVerified,

        full_chain_proven: true,
      },

      safety: {
        target_is_laboratory_template:
          true,

        target_distinct_from_master:
          normalizeId(labTemplate.id) !==
          normalizeId(masterTemplate.id),

        official_template_modified:
          false,

        official_registry_modified:
          false,

        real_user_tracking_modified:
          false,

        laboratory_tracking_only:
          true,

        laboratory_row_remaining:
          false,

        pre_write_revalidation:
          true,

        fingerprint_verified_before_tracking:
          true,

        notion_write_operations:
          notionWriteOperations,

        neon_write_operations:
          neonWriteOperations,

        automatic_sync_executed:
          true,
      },
    });
  } catch (error) {
    console.error(
      "Erreur test-sync-one-tracking-lab :",
      error
    );

    /*
      Nettoyage best-effort si une erreur
      survient après création de la ligne labo.
    */
    if (
      sql &&
      workspaceId &&
      labRowCreated
    ) {
      try {
        await sql`
          DELETE FROM notion_workspace_templates
          WHERE workspace_id = ${workspaceId}
            AND template_key =
              ${LAB_TEMPLATE_KEY}
        `;
      } catch (cleanupError) {
        console.error(
          "Erreur nettoyage tracking labo :",
          cleanupError
        );
      }
    }

    return res
      .status(error.statusCode || 500)
      .json({
        ok: false,
        engine_stage: "2/6",
        error:
          error.message ||
          "Erreur interne du serveur.",
      });
  }
}
