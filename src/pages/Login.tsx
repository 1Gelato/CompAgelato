import { useState } from 'react';
import type { AuthIdentity } from '@shared/api';
import { Button, Field, Input, Spinner } from '../components/ui';
import { errorMessage } from '../lib/data';

/**
 * Écran de connexion.
 *
 * Il s'affiche dès que le serveur exige un compte et qu'aucune session n'est
 * ouverte — dans le navigateur comme dans l'application de bureau branchée.
 * Tant qu'aucun compte n'existe sur le serveur, il ne s'affiche jamais : la
 * bascule est un geste explicite du gérant, pas une surprise au redémarrage.
 */
export function Login({ onDone }: { onDone: (identity: AuthIdentity) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!username.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await window.api.auth.login({ username: username.trim(), password });
      onDone(outcome.identity);
    } catch (err) {
      setError(errorMessage(err));
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="loginwrap">
      <form className="logincard" onSubmit={submit}>
        <div className="loginbrand">
          <div className="loginlogo">CG</div>
          <div>
            <h1>CompaGelato</h1>
            <p className="muted">Connectez-vous pour accéder aux données de l’entreprise.</p>
          </div>
        </div>

        <Field label="Identifiant">
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="prenom"
          />
        </Field>

        <Field label="Mot de passe">
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
        </Field>

        {error && <div className="warnbox">{error}</div>}

        <Button
          type="submit"
          variant="primary"
          disabled={busy || !username.trim() || !password}
          style={{ width: '100%', justifyContent: 'center' }}
        >
          {busy ? <Spinner size={14} /> : 'Se connecter'}
        </Button>
      </form>
    </div>
  );
}
