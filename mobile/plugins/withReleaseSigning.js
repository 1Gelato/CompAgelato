const { withAppBuildGradle } = require('@expo/config-plugins');

/**
 * Signe l'APK de production avec **votre** clé, et non avec la clé de
 * débogage.
 *
 * Pourquoi ce greffon existe : `expo prebuild` régénère `android/` à chaque
 * passage, et le modèle qu'il produit contient
 * `release { signingConfig signingConfigs.debug }` — la clé de débogage, elle
 * aussi régénérée. Deux APK construites à deux moments différents ne portent
 * alors pas la même signature, et Android refuse d'installer la seconde
 * par-dessus la première : il faut désinstaller, donc perdre la session et le
 * miroir hors-ligne du téléphone. Modifier `build.gradle` à la main
 * fonctionnerait jusqu'au prochain `prebuild --clean`, qui l'effacerait.
 *
 * Le greffon réécrit donc le fichier **à chaque génération**, ce qui rend la
 * signature reproductible sans rien versionner de secret.
 *
 * Les identifiants ne vivent pas dans le dépôt : ils sont lus dans les
 * propriétés Gradle, à renseigner une fois dans `~/.gradle/gradle.properties`
 * (hors du dépôt, hors des sauvegardes du projet) :
 *
 *   COMPAGELATO_STORE_FILE=C:/Users/…/cles/compagelato.keystore
 *   COMPAGELATO_STORE_PASSWORD=…
 *   COMPAGELATO_KEY_ALIAS=compagelato
 *   COMPAGELATO_KEY_PASSWORD=…
 *
 * **Absentes, la construction n'échoue pas** : elle retombe sur la clé de
 * débogage. Un poste sans la clé peut ainsi produire une APK d'essai
 * parfaitement installable — c'est seulement l'installation par-dessus une
 * version signée autrement qui ne marchera pas.
 */

/** Bloc `release` ajouté aux configurations de signature. */
const RELEASE_SIGNING = `
        release {
            // Renseignées dans ~/.gradle/gradle.properties, jamais dans le dépôt.
            if (project.hasProperty('COMPAGELATO_STORE_FILE')) {
                storeFile file(COMPAGELATO_STORE_FILE)
                storePassword COMPAGELATO_STORE_PASSWORD
                keyAlias COMPAGELATO_KEY_ALIAS
                keyPassword COMPAGELATO_KEY_PASSWORD
            }
        }`;

/** Choix de la clé au moment de construire, avec repli explicite. */
const RELEASE_CHOICE =
  "signingConfig project.hasProperty('COMPAGELATO_STORE_FILE') " +
  '? signingConfigs.release : signingConfigs.debug';

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    let gradle = cfg.modResults.contents;

    // Déjà appliqué (double passage du greffon) : ne rien faire deux fois.
    if (gradle.includes('COMPAGELATO_STORE_FILE')) return cfg;

    // 1. Ajouter la configuration `release` à la suite de `debug`, dans le
    //    bloc `signingConfigs`. On s'accroche à la fin du bloc `debug`, seul
    //    repère stable du modèle d'Expo.
    const signingBlock = /(signingConfigs\s*\{[\s\S]*?keyPassword 'android'\s*\n\s*\})/;
    if (!signingBlock.test(gradle)) {
      throw new Error(
        'withReleaseSigning : bloc signingConfigs introuvable dans build.gradle. ' +
          'Le modèle d’Expo a changé — vérifiez android/app/build.gradle.',
      );
    }
    gradle = gradle.replace(signingBlock, `$1${RELEASE_SIGNING}`);

    // 2. Faire pointer le type de construction `release` vers cette clé.
    //    La ligne visée est celle qui suit l'avertissement de React Native ;
    //    on remplace la dernière occurrence pour ne pas toucher au type
    //    `debug`, qui porte la même instruction plus haut.
    const marker = 'signingConfig signingConfigs.debug';
    const last = gradle.lastIndexOf(marker);
    if (last === -1) {
      throw new Error(
        'withReleaseSigning : aucune ligne de signature à remplacer dans build.gradle.',
      );
    }
    gradle = gradle.slice(0, last) + RELEASE_CHOICE + gradle.slice(last + marker.length);

    cfg.modResults.contents = gradle;
    return cfg;
  });
};
