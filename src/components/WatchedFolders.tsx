import { useCallback, useEffect, useState } from 'react';
import type { UploadFolder, UploadFolderKind } from '@shared/api';
import { Badge, Button, Card, Icons, IconButton, Select, Spinner, useToast } from './ui';
import { errorMessage } from '../lib/data';

/**
 * Les dossiers de ce poste que le logiciel surveille pour les envoyer au
 * serveur.
 *
 * Le réglage vit ici, sur la page où l'on s'en sert, et non dans un écran de
 * réglages : c'est en regardant ses factures qu'on se demande d'où elles
 * viennent. Chaque page n'affiche que les types qui la concernent — les
 * relevés bancaires n'ont rien à faire sur la page des documents.
 *
 * La carte ne s'affiche qu'en mode branché. Sur un poste autonome, le dossier
 * surveillé fait déjà ce travail : proposer d'« envoyer au serveur » un poste
 * qui est son propre serveur n'aurait aucun sens.
 */

const KIND_LABEL: Record<UploadFolderKind, string> = {
  invoice: 'Factures',
  quote: 'Devis',
  credit: 'Avoirs',
  statement: 'Relevés de compte',
};

export function WatchedFolders({
  kinds,
  subtitle,
}: {
  kinds: UploadFolderKind[];
  subtitle: string;
}) {
  const toast = useToast();
  const [remote, setRemote] = useState<boolean | null>(null);
  const [folders, setFolders] = useState<UploadFolder[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    window.api.folders
      .list()
      .then((all) => setFolders(all.filter((f) => kinds.includes(f.kind))))
      .catch(() => setFolders([]));
    // `kinds` est un littéral recréé à chaque rendu : on le compare par contenu
    // pour ne pas relancer la lecture en boucle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kinds.join('|')]);

  useEffect(() => {
    window.api.app
      .info()
      .then((info) => setRemote(info.mode === 'remote'))
      .catch(() => setRemote(false));
  }, []);

  useEffect(() => {
    if (remote) load();
  }, [remote, load]);

  if (!remote) return null;

  const add = async (kind: UploadFolderKind) => {
    try {
      const picked = await window.api.folders.pick();
      if (!picked) return;
      setBusy(true);
      const all = await window.api.folders.save({ path: picked, kind });
      setFolders(all.filter((f) => kinds.includes(f.kind)));
      toast.push({
        tone: 'success',
        title: 'Dossier surveillé',
        text: 'Ce qui s’y trouve déjà part au serveur, et tout nouveau fichier suivra.',
      });
    } catch (err) {
      toast.push({ tone: 'error', title: 'Impossible', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (folder: UploadFolder) => {
    try {
      const all = await window.api.folders.remove(folder.id);
      setFolders(all.filter((f) => kinds.includes(f.kind)));
    } catch (err) {
      toast.push({ tone: 'error', title: 'Impossible', text: errorMessage(err) });
    }
  };

  const syncNow = async () => {
    setBusy(true);
    try {
      const result = await window.api.folders.syncNow();
      if (result.offline) {
        toast.push({
          tone: 'warn',
          title: 'Serveur injoignable',
          text: 'Rien n’est perdu : l’envoi reprendra tout seul.',
        });
      } else if (result.sent) {
        toast.push({
          tone: 'success',
          title: `${result.sent} pièce${result.sent > 1 ? 's' : ''} envoyée${result.sent > 1 ? 's' : ''}`,
        });
      } else {
        toast.push({ tone: 'info', title: 'Rien de nouveau à envoyer.' });
      }
      if (result.failed.length) {
        toast.push({
          tone: 'warn',
          title: `${result.failed.length} fichier(s) refusé(s)`,
          text: result.failed[0]?.error,
        });
      }
    } catch (err) {
      toast.push({ tone: 'error', title: 'Envoi impossible', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Dossiers de ce poste envoyés au serveur"
      subtitle={subtitle}
      padded={false}
      actions={
        <div className="row" style={{ gap: 8 }}>
          {folders && folders.length > 0 && (
            <Button size="sm" icon={<Icons.refresh size={12} />} onClick={syncNow} loading={busy}>
              Envoyer maintenant
            </Button>
          )}
          <AddFolder kinds={kinds} onPick={add} busy={busy} />
        </div>
      }
    >
      {!folders ? (
        <div className="empty">
          <Spinner size={18} />
        </div>
      ) : folders.length === 0 ? (
        <div className="empty">
          <p className="empty__text">
            Aucun dossier surveillé. Désignez celui où votre logiciel de comptabilité dépose ses
            fichiers : ils partiront au serveur tout seuls, sans que vous ayez à les ajouter un
            à un.
          </p>
        </div>
      ) : (
        <div className="list">
          {folders.map((folder) => (
            <div key={folder.id} className="list__item">
              <Badge tone="info">{KIND_LABEL[folder.kind]}</Badge>
              <div className="truncate mono" style={{ flex: 1, minWidth: 0, fontSize: 13 }}>
                {folder.path}
              </div>
              <IconButton
                title="Ne plus surveiller ce dossier"
                onClick={() => void remove(folder)}
              >
                <Icons.trash size={14} />
              </IconButton>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/** Un seul type : bouton direct. Plusieurs : on demande lequel. */
function AddFolder({
  kinds,
  onPick,
  busy,
}: {
  kinds: UploadFolderKind[];
  onPick: (kind: UploadFolderKind) => void;
  busy: boolean;
}) {
  const [kind, setKind] = useState<UploadFolderKind>(kinds[0]);

  if (kinds.length === 1) {
    return (
      <Button
        size="sm"
        variant="primary"
        icon={<Icons.plus size={12} />}
        loading={busy}
        onClick={() => onPick(kinds[0])}
      >
        Ajouter un dossier
      </Button>
    );
  }

  return (
    <div className="row" style={{ gap: 6 }}>
      <Select value={kind} onChange={(e) => setKind(e.target.value as UploadFolderKind)}>
        {kinds.map((k) => (
          <option key={k} value={k}>
            {KIND_LABEL[k]}
          </option>
        ))}
      </Select>
      <Button
        size="sm"
        variant="primary"
        icon={<Icons.plus size={12} />}
        loading={busy}
        onClick={() => onPick(kind)}
      >
        Ajouter
      </Button>
    </div>
  );
}
