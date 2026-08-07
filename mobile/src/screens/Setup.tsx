import { useState } from 'react';
import { Image, KeyboardAvoidingView, Platform, StyleSheet, Text, View } from 'react-native';
import type { AuthStatus } from '@shared/api';
import { serverCall } from '../core/api';
import { saveServerUrl } from '../lib/runtime';
import { errorMessage } from '../lib/data';
import { Button, Card, Field, Input, Muted } from '../components/ui';
import { colors, spacing } from '../theme';

/**
 * Premier démarrage : où est le serveur ?
 *
 * L'adresse Tailscale est proposée d'office — elle marche du dépôt, de la
 * maison et de la tournée, c'est celle qu'il ne faut plus se poser.
 */
export function SetupScreen({ onDone }: { onDone: (status: AuthStatus) => void }) {
  const [address, setAddress] = useState('100.100.53.66:4680');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const test = async () => {
    setBusy(true);
    setError(null);
    try {
      await saveServerUrl(address);
      const status = (await serverCall('auth', 'status', [])) as AuthStatus;
      onDone(status);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.wrap}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.brand}>
        <Image source={require('../../assets/icon.png')} style={styles.logo} />
        <Text style={styles.title}>CompaGelato</Text>
        <Muted>Les données de l’entreprise, dans votre poche.</Muted>
      </View>

      <Card>
        <Field
          label="Adresse du serveur"
          hint="L’adresse Tailscale du serveur du dépôt. Vérifiez que Tailscale est activé sur ce téléphone."
        >
          <Input
            value={address}
            onChangeText={setAddress}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="100.100.53.66:4680"
          />
        </Field>
        {error ? <Text style={{ color: colors.red, fontSize: 13 }}>{error}</Text> : null}
        <Button title="Se connecter au serveur" variant="primary" onPress={test} busy={busy} />
      </Card>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    backgroundColor: colors.bg,
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.xl,
  },
  brand: { alignItems: 'center', gap: 6 },
  logo: { width: 76, height: 76, borderRadius: 18, marginBottom: 6 },
  title: { fontSize: 24, fontWeight: '700', color: colors.text },
});
