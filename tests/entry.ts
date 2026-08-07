/** Point d'entrée des tests : réexporte les services testables sans Electron. */
export * from '../electron/services/text';
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
export { CHANNELS } from '../shared/api';
// Le magasin lui-même : sans Electron, il se pilote en Node. C'est ainsi qu'on
// vérifie la restauration d'une sauvegarde venue d'une autre machine.
export { store as dataStore, isForeignPath, defaultWatchFolder } from '../electron/store';
