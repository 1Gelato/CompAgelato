import { useState } from 'react';
import { Image, KeyboardAvoidingView, Platform, StyleSheet, Text, View } from 'react-native';
import type { AuthIdentity } from '@shared/api';
import { login } from '../lib/runtime';
import { errorMessage } from '../lib/data';
import { Button, Card, Field, Input, Muted } from '../components/ui';
import { colors, font, spacing } from '../theme';

/** Connexion à un compte. La session d'appareil dure 180 jours. */
export function LoginScreen({
  onDone,
  onChangeServer,
}: {
  onDone: (identity: AuthIdentity) => void;
  onChangeServer: () => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!username.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await login(username.trim(), password));
    } catch (err) {
      setError(errorMessage(err));
      setPassword('');
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
        <Muted>Connectez-vous pour accéder aux données de l’entreprise.</Muted>
      </View>

      <Card>
        <Field label="Identifiant">
          <Input
            value={username}
            onChangeText={setUsername}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="prenom"
          />
        </Field>
        <Field label="Mot de passe">
          <Input
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            placeholder="••••••••"
            onSubmitEditing={submit}
          />
        </Field>
        {error ? <Text style={{ color: colors.red, fontSize: 13 }}>{error}</Text> : null}
        <Button
          title="Se connecter"
          variant="primary"
          onPress={submit}
          busy={busy}
          disabled={!username.trim() || !password}
        />
        <Button title="Changer de serveur" variant="ghost" onPress={onChangeServer} />
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
  title: { ...font.title, color: colors.text },
});
