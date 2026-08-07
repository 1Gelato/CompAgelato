import { useCallback, useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import * as Updates from 'expo-updates';
import * as Application from 'expo-application';
import type { AuthIdentity, SyncStatus } from '@shared/api';
import { ROLE_LABEL } from '@shared/types';
import { api, logout, serverUrl } from '../lib/runtime';
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
 * et la mise à jour de l'application — vérifiée toute seule au lancement, et
 * déclenchable ici d'un bouton pour l'app qu'on ne referme jamais.
 */
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

  const refreshSync = useCallback(() => setStatus(syncStatus()), []);

  useEffect(() => {
    const timer = setInterval(refreshSync, 8000);
    return () => clearInterval(timer);
  }, [refreshSync]);

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

      {/* ------------------------------------------------ Mise à jour */}
      <Card>
        <SectionTitle>Mise à jour de l’application</SectionTitle>
        <InfoRow
          label="Version"
          value={`${Application.nativeApplicationVersion ?? '—'}${
            Updates.updateId ? ` · ${Updates.updateId.slice(0, 8)}` : ''
          }`}
        />
        {updateState === 'ready' ? (
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
