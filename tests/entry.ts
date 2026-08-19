/** Point d'entrée des tests : réexporte les services testables sans Electron. */
export * from '../electron/services/text';
export { matchClient, rememberClientAlias, forgetLearnedAliases } from '../electron/services/clients';
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
export { buildDashboard } from '../electron/services/dashboard';
export { applyAllPending, applyDocumentToStock } from '../electron/services/stock';
export { awaitsStock, DEFAULT_DESKTOP_NOTIFY } from '../shared/types';
// Notifications du poste : la décision de montrer ou non vit hors d'Electron,
// donc elle se vérifie sans ouvrir de fenêtre.
export { shouldNotify, SeenActivity, SOURCE_PAGE } from '../electron/services/desktopNotify';
export { announce, setActivityPublisher } from '../electron/services/activity';
