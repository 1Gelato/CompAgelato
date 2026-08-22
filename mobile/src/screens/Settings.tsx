import { useCallback, useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import * as Updates from 'expo-updates';
import * as Application from 'expo-application';
import type { AuthIdentity, SyncStatus } from '@shared/api';
import { ROLE_LABEL } from '@shared/types';
import { api, logout, serverUrl } from '../lib/runtime';
import { isExpoGo } from '../lib/environment';
import { pushState, registerForPush, type PushState } from '../lib/push';
import { discardIntent, retryNow, syncStatus } from '../core/offline';
import { errorMessage } from '../lib/data';
import {
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
 * Les réglages du téléphone : mon compte, la mise à jour de l'application,
 * le mot de passe.
 *
 * La synchronisation et les notifications **n'ont plus de carte** : elles
 * marchent, et un écran qui répète en permanence que tout va bien n'apprend
 * rien. Elles ne reparaissent que le jour où elles échouent — le bandeau
 * orange en haut de l'application dit déjà le hors-ligne, et les deux
 * encarts ci-dessous ne s'affichent que s'il y a un geste à faire.
 */
export function SettingsScreen({
  identity,
  onSignedOut,
}: {
  identity: AuthIdentity | null;
  onSignedOut: () => void;
}) {
  const toast = useToast();
  // Ne change pas d'un rendu à l'autre : c'est la nature de l'installation.
  const expoGo = isExpoGo();
  const [status, setStatus] = useState<SyncStatus>(syncStatus());
  const [busySync, setBusySync] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busyPassword, setBusyPassword] = useState(false);
  const [updateState, setUpdateState] = useState<'idle' | 'checking' | 'downloading' | 'ready' | 'none'>('idle');
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [push, setPush] = useState<PushState | null>(pushState());
  const [busyPush, setBusyPush] = useState(false);

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

      {/* --------------------------------- Modifications refusées (rare)
          Le seul reste de l'ancienne carte « Synchronisation ». Un geste que
          le serveur refuse resterait bloqué dans la file sans un endroit pour
          l'abandonner : cet encart est ce recours, et il n'apparaît que dans
          ce cas-là. */}
      {status.failed.length > 0 && (
        <Card>
          <SectionTitle>Modifications refusées</SectionTitle>
          <Muted size={12}>
            Le serveur a refusé ces gestes. Ils resteront en attente tant qu’ils n’auront pas été
            abandonnés.
          </Muted>
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
                {intent.namespace}.{intent.method}
              </Text>
              <Muted size={12}>{intent.error}</Muted>
              <Button
                title="Abandonner cette modification"
                onPress={async () => setStatus(await discardIntent(intent.id))}
              />
            </View>
          ))}
          <Button title="Réessayer d’envoyer" onPress={retry} busy={busySync} />
        </Card>
      )}

      {/* ------------------------------- Notifications en panne (rare)
          Rien tant qu'elles fonctionnent. Sans cet encart, un abonnement
          refusé serait invisible : on croirait l'application muette. */}
      {push && (push.status !== 'active' || !push.serverReady) && (
        <Card>
          <SectionTitle>Notifications</SectionTitle>
          {push.status === 'active' ? (
            <Muted size={12}>
              Ce téléphone est abonné, mais le serveur n’a pas encore sa clé Firebase : rien ne
              partira tant qu’elle n’est pas installée.
            </Muted>
          ) : push.status === 'refusée' ? (
            <Muted size={12}>
              Les notifications sont refusées sur ce téléphone. Autorisez-les dans les réglages
              Android de CompaGelato, puis touchez « Réessayer ».
            </Muted>
          ) : (
            <Muted size={12}>{push.reason}</Muted>
          )}
          <Button title="Réessayer" onPress={retryPush} busy={busyPush} />
        </Card>
      )}

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
          // Pas de service de mises à jour par les airs : promettre un bouton
          // qui ne peut rien faire serait pire que de ne rien afficher. Reste
          // à dire pourquoi, et la raison n'est pas la même dans les deux cas.
          expoGo ? (
            <Muted size={12}>
              Essai dans Expo Go : le code arrive en direct du serveur de développement, et se
              recharge en secouant l’appareil. Les mises à jour par les airs ne concernent que
              l’application installée.
            </Muted>
          ) : (
            <Muted size={12}>
              Cette installation se met à jour en réinstallant l’application — il n’y a pas de
              mise à jour par les airs. Demandez la nouvelle version à Quentin.
            </Muted>
          )
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
                    ? 'Déjà à jour — revérifier'
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
