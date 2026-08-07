const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

/**
 * L'app mobile vit dans le dépôt CompaGelato et importe le contrat commun
 * (`@shared/…`) directement depuis `../shared` : types, canaux, table des
 * droits et aides de mise en forme sont les mêmes objets que ceux du bureau,
 * du serveur et du navigateur — ils ne peuvent pas diverger.
 */
const config = getDefaultConfig(__dirname);

const shared = path.resolve(__dirname, '..', 'shared');

config.watchFolders = [shared];
config.resolver.extraNodeModules = {
  '@shared': shared,
};

module.exports = config;
