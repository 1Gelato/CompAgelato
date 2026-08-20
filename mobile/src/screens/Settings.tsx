import { useCallback, useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import * as Updates from 'expo-updates';
import * as Application from 'expo-application';
import type { AuthIdentity, SyncStatus } from '@shared/api';
import { ROLE_LABEL } from '@shared/types';
import { api, logout, serverUrl } from '../lib/runtime';
import { pushState, registerForPush, type PushState } from '../lib/push';
import { discardIntent, retryNow, syncStatus } from '../core/offline';
import { errorMessage } from '../lib/data';
import {
  Badge,
  Button,
  Card,
  Field,
  InfoRow,
  Input,
  Muted,
  SectionTitle,
  useToast,
} from '../components/ui';
import { colors, spacing } from '../theme';

/**
 * Les réglages du téléphone : mon compte, la synchronisation de cet appareil,
 * les notifications, et la mise à jour de l'application.
 */

/** L'état de l'abonnement, dit en français plutôt qu'en code. */
function pushLabel(state: PushState | null): string {
  if (!state) return 'Vérification…';
  switch (state.status) {
    case 'active':
      return state.serverReady ? 'Actives ✓' : 'Abonné — serveur non configuré';
    case 'refusée':
      return 'Refusées sur ce téléphone';
    case 'indisponible':
      return 'Indisponibles';
    default:
      return 'Erreur';
  }
}
export function SettingsScreen({
  identity,
  onSignedOut,
}: {
  identity: AuthIdentity | null;
  onSignedOut: () => void;
}) {
  const toast = useToast();
  const [status, setStatus] = useState<SyncStatus>(syncStatus());
  const [busySync, setBusySync] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busyPassword, setBusyPassword] = useState(false);
  const [updateState, setUpdateState] = useState<'idle' | 'checking' | 'downloading' | 'ready' | 'none'>('idle');
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [push, setPush] = useState<PushState | null>(pushState());
  const [busyPush, setBusyPush] = useState(false);
  const [busyTest, setBusyTest] = useState(false);

  const refreshSync = useCallback(() => setStatus(syncStatus()), []);

  useEffect(() => {
    const timer = setInterval(refreshSync, 8000);
    return () => clearInterval(timer);
  }, [refreshSync]);

  // L'abonnement est demandé au démarrage de l'application ; on relit
  // simplement son résultat en ouvrant cet écran.
  useEffect(() => {
    if (!pushState()) void registerForPush().then(setPush);
    else setPush(pushState());
  }, []);

  const retryPush = async () => {
    setBusyPush(true);
    try {
      setPush(await registerForPush());
    } finally {
      setBusyPush(false);
    }
  };

  const sendTestPush = async () => {
    setBusyTest(true);
    try {
      const result = await api.push.test();
      toast.push({
        tone: result.sent ? 'success' : 'warn',
        title: result.sent ? 'Notification envoyée' : 'Rien n’est parti',
        text: result.reason ?? `${result.sent} appareil(s) prévenu(s).`,
      });
    } catch (err) {
      toast.push({ tone: 'danger', title: 'Échec', text: errorMessage(err) });
    } finally {
      setBusyTest(false);
    }
  };

  /**
   * Le bouton « Mettre à jour ». L'application vérifie déjà toute seule au
   * lancement (`checkAutomatically: ON_LOAD`) — mais une app de tournée ne se
   * relance jamais : ce bouton est le rattrapage, sans rien réinstaller.
   */
  const checkUpdate = async () => {
    setUpdateError(null);
    setUpdateState('checking');
    try {
      const check = await Updates.checkForUpdateAsync();
      if (!check.isAvailable) {
        setUpdateState('none');
        return;
      }
      setUpdateState('downloading');
      await Updates.fetchUpdateAsync();
      setUpdateState('ready');
    } catch (err) {
      setUpdateState('idle');
      // En développement (Expo Go), le service de mise à jour n'existe pas.
      setUpdateError(errorMessage(err));
    }
  };

  const retry = async () => {
    setBusySync(true);
    try {
      setStatus(await retryNow());
    } finally {
      setBusySync(false);
    }
  };

  const changePassword = async () => {
    setBusyPassword(true);
    try {
      await api.auth.changePassword({ current, next });
      toast.push({
        tone: 'success',
        title: 'Mot de passe changé',
        text: 'Vos autres appareils devront se reconnecter.',
      });
      setCurrent('');
      setNext('');
      onSignedOut();
    } catch (err) {
      toast.push({ tone: 'danger', title: 'Échec', text: errorMessage(err) });
    } finally {
      setBusyPassword(false);
    }
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: spacing.md, gap: spacing.md }}
    >
      {/* ------------------------------------------------ Mon compte */}
      <Card>
        <SectionTitle>Mon compte</SectionTitle>
        {identity ? (
          <>
            <InfoRow label="Nom" value={identity.displayName} />
            <InfoRow label="Identifiant" value={identity.username} />
            <InfoRow label="Rôle" value={ROLE_LABEL[identity.role]} />
          </>
        ) : (
          <Muted>Serveur sans comptes : accès par jeton partagé.</Muted>
        )}
        <InfoRow label="Serveur" value={serverUrl()} />
        <Button
          title="Se déconnecter"
          onPress={async () => {
            await logout();
            onSignedOut();
          }}
        />
      </Card>

      {/* -------------------------------------------- Synchronisation */}
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <SectionTitle>Synchronisation</SectionTitle>
          <Badge tone={status.online ? 'success' : 'warn'}>
            {status.online ? 'En ligne' : 'Hors ligne'}
          </Badge>
        </View>
        <Muted>
          {status.lastPullAt
            ? `Dernière synchronisation : ${new Date(status.lastPullAt).toLocaleString('fr-FR')}`
            : 'Pas encore synchronisé.'}
        </Muted>
        {status.pending.length > 0 && (
          <Muted>{status.pending.length} modification(s) en attente de rejeu.</Muted>
        )}
        {status.failed.map((intent) => (
          <View
            key={intent.id}
            style={{
              backgroundColor: colors.orangeSoft,
              borderRadius: 8,
              padding: spacing.md,
              gap: 6,
            }}
          >
            <Text style={{ fontWeight: '600', color: colors.text, fontSize: 13 }}>
              Refusée par le serveur : {intent.namespace}.{intent.method}
            </Text>
            <Muted size={12}>{intent.error}</Muted>
            <Button
              title="Abandonner cette modification"
              onPress={async () => setStatus(await discardIntent(intent.id))}
            />
          </View>
        ))}
        <Button title="Synchroniser maintenant" onPress={retry} busy={busySync} />
      </Card>

      {/* ------------------------------------------------ Notifications */}
      <Card>
        <SectionTitle>Notifications</SectionTitle>
        <InfoRow label="État" value={pushLabel(push)} />
        {push?.status === 'active' && !push.serverReady && (
          <Muted size={12}>
            Ce téléphone est abonné, mais le serveur n’a pas encore sa clé Firebase : rien ne
            partira tant qu’elle n’est pas installée.
          </Muted>
        )}
        {push?.status === 'refusée' && (
          <Muted size={12}>
            Autorisez les notifications dans les réglages Android de CompaGelato, puis touchez
            « Réessayer ».
          </Muted>
        )}
        {(push?.status === 'indisponible' || push?.status === 'erreur') && (
          <Muted size={12}>{push.reason}</Muted>
        )}
        <Button title="Réessayer" onPress={retryPush} busy={busyPush} />
        {push?.status === 'active' && push.serverReady && (
          <Button title="Envoyer une notification d’essai" onPress={sendTestPush} busy={busyTest} />
        )}
        <Muted size={12}>
          CompaGelato vous prévient des arrivées — jamais de vos propres gestes. Vous ne recevez
          que ce que votre rôle vous permet de consulter.
        </Muted>
      </Card>

      {/* ------------------------------------------------ Mise à jour */}
      <Card>
        <SectionTitle>Mise à jour de l’application</SectionTitle>
        <InfoRow
          label="Version"
          value={`${Application.nativeApplicationVersion ?? '—'}${
            Updates.updateId ? ` · ${Updates.updateId.slice(0, 8)}` : ''
          }`}
        />
        {!Updates.isEnabled ? (
          // APK construite localement, sans service de mises à jour par les
          // airs : promettre un bouton qui ne peut rien faire serait pire que
          // de ne rien afficher.
          <Muted size={12}>
            Cette installation se met à jour en réinstallant l’APK — il n’y a pas de mise à jour
            par les airs. Demandez la nouvelle version à Quentin.
          </Muted>
        ) : updateState === 'ready' ? (
          <>
            <Muted>Mise à jour téléchargée. L’application va se relancer.</Muted>
            <Button
              title="Relancer maintenant"
              variant="primary"
              onPress={() => void Updates.reloadAsync()}
            />
          </>
        ) : (
          <Button
            title={
              updateState === 'checking'
                ? 'Vérification…'
                : updateState === 'downloading'
                  ? 'Téléchargement…'
                  : updateState === 'none'
                    ? 'Déjà à jour ✓ — revérifier'
                    : 'Vérifier les mises à jour'
            }
            onPress={checkUpdate}
            busy={updateState === 'checking' || updateState === 'downloading'}
          />
        )}
        {updateError ? <Muted size={12}>{updateError}</Muted> : null}
        <Muted size={12}>
          L’application vérifie aussi toute seule à chaque lancement. Ce bouton sert quand elle
          reste ouverte des journées entières.
        </Muted>
      </Card>

      {/* ------------------------------------------------ Mot de passe */}
      {identity && (
        <Card>
          <SectionTitle>Changer mon mot de passe</SectionTitle>
          <Field label="Mot de passe actuel">
            <Input value={current} onChangeText={setCurrent} secureTextEntry />
          </Field>
          <Field label="Nouveau mot de passe" hint="8 caractères minimum.">
            <Input value={next} onChangeText={setNext} secureTextEntry />
          </Field>
          <Button
            title="Changer"
            variant="primary"
            onPress={changePassword}
            busy={busyPassword}
            disabled={!current || next.length < 8}
          />
        </Card>
      )}
    </ScrollView>
  );
}
