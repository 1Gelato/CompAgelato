/** Point d'entrée des tests : réexporte les services testables sans Electron. */
export * from '../electron/services/text';
export {
  matchClient,
  rememberClientAlias,
  forgetLearnedAliases,
  importClientsFile,
  importProductsFile,
} from '../electron/services/clients';
// Lecture d'un catalogue d'articles : état, nature, taux, prix de vente —
// chaque interprétation se vérifie valeur par valeur.
export {
  parseActive,
  explicitProductType,
  guessProductType,
  parseInvoicedAs,
  parseVatRate,
  saleHtFrom,
} from '../electron/services/productFields';
// Adresses en une ligne : découpage, nettoyage et réparation des fiches.
export { cleanAddressLine, parseAddressLine, repairAddress } from '../electron/services/address';
// Géolocalisation en tâche de fond : le lancement, l'avancement, l'attente —
// jamais de vrai appel réseau dans la suite, le géocodeur est injecté.
export { addressQuery, geocodeStatus, startGeocode, waitGeocode } from '../electron/services/geocode';
// Bons de livraison : numérotation annuelle, annonce au bureau, facturation.
export {
  deliveryTotal,
  listDeliveryNotes,
  markDeliveryInvoiced,
  nextDeliveryNumber,
  removeDeliveryNote,
  upsertDeliveryNote,
} from '../electron/services/delivery';
export * from '../electron/services/pdf';
export * from '../electron/services/parseInvoice';
export * from '../electron/services/facturx';
export * from '../electron/services/tabular';
export * from '../electron/services/bankStatement';
export * from '../electron/services/registerRules';
export * from '../electron/services/packaging';
export * from '../electron/services/notify';
export * from '../electron/services/optimize';
export * from '../electron/services/routing';
export * from '../electron/services/mapLinks';
export * from '../electron/services/mail';
export * from '../electron/services/updater';
// Sauvegardes automatiques : le planificateur du serveur et la copie que chaque
// poste rapatrie. Ni l'un ni l'autre ne dépend d'Electron.
export * from '../electron/services/autoBackup';
// Mise à jour automatique du serveur : la décision de passer, le refus quand
// rien ne le relancerait, et l'arrêt après plusieurs échecs — tout se vérifie
// sans toucher au dépôt.
export {
  shouldRunAt,
  localDay,
  updateNow,
  startAutoUpdate,
  autoUpdateHourFromEnv,
  readUpdateState,
} from '../electron/services/autoUpdate';
export * from '../electron/services/serverBackup';
// Liaison au serveur et proxy HTTP : sans Electron eux non plus, ce qui permet
// de vérifier le mode branché de l'application de bureau contre un vrai serveur.
export * from '../electron/connection';
export * from '../electron/remote';
export * from '../electron/offline';
// Dossiers du poste surveillés et envoyés au serveur : ni Electron ni chokidar
// dans le cœur, donc exerçable contre un vrai serveur.
export * from '../electron/folders';
export { pendingFiles, uploadPending } from '../electron/services/uploadWatcher';
export { CHANNELS } from '../shared/api';
// Calculs partagés avec les écrans : marge et prix TTC, dont les définitions
// doivent coïncider avec celles du logiciel de comptabilité.
export { marginRate, priceTtc } from '../shared/format';
// Ce qu'un client a déjà commandé : même code sur le bureau, sur le téléphone
// et ici — d'où l'intérêt de le vérifier une bonne fois.
export { clientOrderHistory } from '../shared/orders';
// Ce qui ressemble à une ligne d'article sans en être une : le lecteur de PDF
// s'en sert pour ne pas la lire, les écrans pour ne pas la montrer.
export { looksLikeVatRecapRow, cleanItemLabel } from '../shared/invoiceLines';
// Le magasin lui-même : sans Electron, il se pilote en Node. C'est ainsi qu'on
// vérifie la restauration d'une sauvegarde venue d'une autre machine.
export { store as dataStore, isForeignPath, defaultWatchFolder } from '../electron/store';
// Ingestion d'une pièce et tableau de bord : c'est là que se joue le sort des
// factures brouillon, qui ne doivent ni compter dans le chiffre d'affaires ni
// sortir du stock.
export { ingestParsedDocument, announceImported } from '../electron/services/documents';
// Le suivi des tâches : journal, corbeille restaurable, purge, tri par
// priorité — tout le métier vit hors d'Electron, donc tout se vérifie ici.
export {
  upsertTask,
  trashTask,
  restoreTask,
  purgeTask,
  setTaskStatus,
  listTasks,
  listTaskPeople,
} from '../electron/services/tasks';
// Le contexte d'appel, pour signer les gestes d'un utilisateur dans les tests.
export { withContext } from '../electron/context';
// Notifications natives : la signature du jeton Google, le cache, le tri des
// destinataires et le traitement des appareils disparus — tout se vérifie sans
// jamais appeler Firebase.
export {
  signAssertion,
  accessToken,
  sendPush,
  configureFcm,
  fcmEnabled,
  readServiceAccount,
  fcmFromEnv,
} from '../electron/services/fcm';
// Mises à jour mobiles auto-hébergées : la description d'un export Metro et
// le manifeste servi aux téléphones se vérifient sur un export fabriqué.
export {
  describeExport,
  buildManifest,
  resolveAsset,
  readMobileUpdateState,
  readRuntimeVersion,
  hashToUuid,
} from '../electron/services/expoUpdates';
export {
  registerDevice,
  unregisterDevice,
  listDevices,
  recipientsFor,
  pushActivityToDevices,
  forgetDevicesOfSession,
  forgetDevicesOfUser,
} from '../electron/services/pushDevices';
export { buildDashboard } from '../electron/services/dashboard';
export { applyAllPending, applyDocumentToStock } from '../electron/services/stock';
export { awaitsStock, DEFAULT_DESKTOP_NOTIFY } from '../shared/types';
// Notifications du poste : la décision de montrer ou non vit hors d'Electron,
// donc elle se vérifie sans ouvrir de fenêtre.
export { shouldNotify, SeenActivity, SOURCE_PAGE } from '../electron/services/desktopNotify';
export { announce, setActivityPublisher } from '../electron/services/activity';
