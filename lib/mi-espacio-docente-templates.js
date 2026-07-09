/*
  Registre officiel versionné des templates
  de Mi Espacio Docente.

  IMPORTANT :
  - aucun template_id Notion n'est codé en dur ;
  - aucun database_id n'est codé en dur ;
  - aucun data_source_id n'est codé en dur ;
  - les IDs sont propres à chaque workspace ;
  - setup.js devra les détecter dynamiquement.

  Ce registre sert à :
  - identifier les templates officiels ;
  - gérer leur version ;
  - détecter les templates absents ;
  - détecter les versions obsolètes ;
  - préparer les créations futures ;
  - préparer les mises à jour futures ;
  - protéger les personnalisations locales ;
  - gérer les conflits.

  La propagation réelle des créations et mises
  à jour devra être activée uniquement après
  validation du prototype API.
*/

export const
  MI_ESPACIO_DOCENTE_TEMPLATES_VERSION =
    "1.0.0";

export const
  MI_ESPACIO_DOCENTE_TEMPLATES = {
    class_dashboard: {
      componentKey: "classes",

      name:
        "🎓 Tableau de bord classe",

      version:
        "1.0.0",

      expectedDefault:
        true,

      updatePolicy:
        "managed",

      localChangesPolicy:
        "protect",

      propagation: {
        newInstallations:
          true,

        existingInstallations:
          true,

        createIfMissing:
          true,

        updateIfOutdated:
          true,

        overwriteLocalChanges:
          false,
      },
    },

    student_sheet: {
      componentKey: "eleves",

      name:
        "👨‍🎓 Fiche élève",

      version:
        "1.0.0",

      expectedDefault:
        false,

      updatePolicy:
        "managed",

      localChangesPolicy:
        "protect",

      propagation: {
        newInstallations:
          true,

        existingInstallations:
          true,

        createIfMissing:
          true,

        updateIfOutdated:
          true,

        overwriteLocalChanges:
          false,
      },
    },

    attendance_sheet: {
      componentKey:
        "feuilles_appel",

      name:
        "📋 Modèle — Feuille d’appel",

      version:
        "1.0.0",

      expectedDefault:
        true,

      updatePolicy:
        "managed",

      localChangesPolicy:
        "protect",

      propagation: {
        newInstallations:
          true,

        existingInstallations:
          true,

        createIfMissing:
          true,

        updateIfOutdated:
          true,

        overwriteLocalChanges:
          false,
      },
    },

    lesson_sheet: {
      componentKey: "seances",

      name:
        "🧩 Fiche séance",

      version:
        "1.0.0",

      expectedDefault:
        false,

      updatePolicy:
        "managed",

      localChangesPolicy:
        "protect",

      propagation: {
        newInstallations:
          true,

        existingInstallations:
          true,

        createIfMissing:
          true,

        updateIfOutdated:
          true,

        overwriteLocalChanges:
          false,
      },
    },

    sequence_sheet: {
      componentKey:
        "sequences",

      name:
        "📚 Fiche séquence",

      version:
        "1.0.0",

      expectedDefault:
        false,

      updatePolicy:
        "managed",

      localChangesPolicy:
        "protect",

      propagation: {
        newInstallations:
          true,

        existingInstallations:
          true,

        createIfMissing:
          true,

        updateIfOutdated:
          true,

        overwriteLocalChanges:
          false,
      },
    },
  };

export const
  MI_ESPACIO_DOCENTE_TEMPLATE_STATUSES = {
    CURRENT:
      "current",

    OUTDATED:
      "outdated",

    MISSING:
      "missing",

    LOCALLY_MODIFIED:
      "locally_modified",

    CONFLICT:
      "conflict",

    UNKNOWN:
      "unknown",
  };

export default
  MI_ESPACIO_DOCENTE_TEMPLATES;
