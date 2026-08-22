import { useCallback, useEffect, useRef, useState } from 'react';
import { LayoutAnimation, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import {
  DefaultTheme,
  NavigationContainer,
  type NavigationContainerRef,
} from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import {
  createNativeStackNavigator,
  type NativeStackNavigationOptions,
} from '@react-navigation/native-stack';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import type { AuthIdentity, AuthStatus, ChannelName } from '@shared/api';
import { mayCall } from '@shared/api';
import { boot, setAuthRequiredHandler, startLive } from './src/lib/runtime';
import { onNotificationOpened, registerForPush } from './src/lib/push';
import { onOfflineChange, syncStatus } from './src/core/offline';
import { refreshAll, setCurrentRole, useTasks } from './src/lib/data';
import { Loading, ToastProvider, useToast } from './src/components/ui';
import { colors } from './src/theme';
import { SetupScreen } from './src/screens/Setup';
import { LoginScreen } from './src/screens/Login';
import {
  RouteAddStopScreen,
  RouteDetailScreen,
  RoutesListScreen,
  type RoutesStackParams,
} from './src/screens/Routes';
import {
  BonDetailScreen,
  BonNouveauScreen,
  BonsListScreen,
  type BonsStackParams,
} from './src/screens/Bons';
import { ClientDetailScreen, ClientsListScreen, type ClientsStackParams } from './src/screens/Clients';
import {
  DocumentDetailScreen,
  DocumentsListScreen,
  type DocumentsStackParams,
} from './src/screens/Documents';
import { ProductDetailScreen, StockListScreen, type StockStackParams } from './src/screens/Stock';
import { CahiersScreen } from './src/screens/Cahiers';
import { TachesScreen } from './src/screens/Taches';
import { PlusScreen } from './src/screens/Plus';
import { BanqueScreen } from './src/screens/Banque';
import { DashboardScreen } from './src/screens/Dashboard';
import { SettingsScreen } from './src/screens/Settings';

/**
 * CompaGelato mobile — la même donnée que le bureau et le navigateur, par le
 * même serveur, avec les mêmes droits. Une seule base de code, Android et iOS.
 */

/* ------------------------------------------------------------------ */
/* Thème de la navigation                                              */
/* ------------------------------------------------------------------ */

/**
 * Sans thème, React Navigation peint sa chrome avec ses propres couleurs —
 * un bleu #007AFF qui n'est pas l'accent de l'app, un fond #F2F2F2 qui n'est
 * pas le nôtre. Trois bleus coexistaient dans le produit ; celui-ci n'était
 * même pas choisi. Le spread de `DefaultTheme` est obligatoire : le type v7
 * exige aussi `fonts`, qu'on n'a aucune raison de redéfinir.
 */
const NAV_THEME = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    primary: colors.accent,
    background: colors.bg,
    card: colors.card,
    text: colors.text,
    border: colors.separator,
    notification: colors.red,
  },
};

/** En-têtes plats, partagés par les six piles : fond de l'app, titre 17/700. */
const STACK_OPTIONS: NativeStackNavigationOptions = {
  headerShadowVisible: false,
  headerStyle: { backgroundColor: colors.bg },
  headerTitleStyle: { fontSize: 17, fontWeight: '700', color: colors.text },
  headerTintColor: colors.accent,
  contentStyle: { backgroundColor: colors.bg },
};

/* ------------------------------------------------------------------ */
/* Piles de navigation                                                 */
/* ------------------------------------------------------------------ */

const RoutesStack = createNativeStackNavigator<RoutesStackParams>();
const BonsStack = createNativeStackNavigator<BonsStackParams>();
const ClientsStack = createNativeStackNavigator<ClientsStackParams>();
const DocumentsStack = createNativeStackNavigator<DocumentsStackParams>();
const StockStack = createNativeStackNavigator<StockStackParams>();

function RoutesFlow() {
  return (
    <RoutesStack.Navigator screenOptions={STACK_OPTIONS}>
      <RoutesStack.Screen name="RoutesList" component={RoutesListScreen} options={{ title: 'Tournées' }} />
      <RoutesStack.Screen name="RouteDetail" component={RouteDetailScreen} options={{ title: 'Tournée' }} />
      <RoutesStack.Screen
        name="RouteAddStop"
        component={RouteAddStopScreen}
        options={{ title: 'Ajouter des arrêts' }}
      />
      {/* Le bon se remplit sans quitter la tournée : client et tournée pré-remplis. */}
      <RoutesStack.Screen
        name="RouteBon"
        component={BonNouveauScreen as never}
        options={{ title: 'Bon de livraison' }}
      />
    </RoutesStack.Navigator>
  );
}

function BonsFlow() {
  return (
    <BonsStack.Navigator screenOptions={STACK_OPTIONS}>
      <BonsStack.Screen name="BonsList" component={BonsListScreen} options={{ title: 'Bons de livraison' }} />
      <BonsStack.Screen name="BonDetail" component={BonDetailScreen} options={{ title: 'Bon de livraison' }} />
      <BonsStack.Screen
        name="BonNouveau"
        component={BonNouveauScreen as never}
        options={{ title: 'Nouveau bon' }}
      />
    </BonsStack.Navigator>
  );
}

function ClientsFlow() {
  return (
    <ClientsStack.Navigator screenOptions={STACK_OPTIONS}>
      <ClientsStack.Screen name="ClientsList" component={ClientsListScreen} options={{ title: 'Clients' }} />
      <ClientsStack.Screen name="ClientDetail" component={ClientDetailScreen} options={{ title: 'Client' }} />
    </ClientsStack.Navigator>
  );
}

function DocumentsFlow() {
  return (
    <DocumentsStack.Navigator screenOptions={STACK_OPTIONS}>
      <DocumentsStack.Screen
        name="DocumentsList"
        component={DocumentsListScreen}
        options={{ title: 'Documents' }}
      />
      <DocumentsStack.Screen
        name="DocumentDetail"
        component={DocumentDetailScreen}
        options={{ title: 'Document' }}
      />
    </DocumentsStack.Navigator>
  );
}

function StockFlow() {
  return (
    <StockStack.Navigator screenOptions={STACK_OPTIONS}>
      <StockStack.Screen name="StockList" component={StockListScreen} options={{ title: 'Stock' }} />
      <StockStack.Screen name="ProductDetail" component={ProductDetailScreen} options={{ title: 'Article' }} />
    </StockStack.Navigator>
  );
}

/* ------------------------------------------------------------------ */
/* Onglets, filtrés par rôle                                           */
/* ------------------------------------------------------------------ */

/**
 * Quatre onglets pour le quotidien, plus « Plus » pour le reste.
 *
 * Neuf onglets tenaient dans la barre, mais au prix de libellés tronqués
 * (« Tourn… », « Régla… ») et de cibles trop étroites pour un pouce. Ce qu'on
 * ouvre tous les jours reste à un geste ; ce qu'on consulte de temps en temps
 * passe dans une grille lisible.
 */
type TabName = 'Tournées' | 'Tâches' | 'Cahiers' | 'Clients' | 'Plus';

/** Écrans atteints par l'onglet « Plus », dans sa propre pile. */
type PlusStackParams = {
  PlusIndex: undefined;
  Bons: undefined;
  Documents: undefined;
  Stock: undefined;
  Banque: undefined;
  Activité: undefined;
  Réglages: undefined;
};

/**
 * Le canal qui décide de la visibilité de chaque onglet — même mécanique que
 * le bureau : le masquage est un confort, le serveur refuse de toute façon.
 * Un livreur voit trois onglets : Tournées, Clients, Réglages.
 */
const TAB_CHANNEL: Record<TabName, ChannelName | null> = {
  Tournées: 'routes:list',
  Tâches: 'tasks:list',
  Cahiers: 'registers:list',
  Clients: 'clients:list',
  Plus: null,
};

/**
 * L'onglet actif porte l'icône pleine, l'inactif le contour : l'état se lit
 * à la forme, pas seulement à la couleur. « Plus » n'a pas de variante
 * pleine, et c'est normal.
 */
const TAB_ICON: Record<
  TabName,
  { focused: keyof typeof Ionicons.glyphMap; unfocused: keyof typeof Ionicons.glyphMap }
> = {
  Tournées: { focused: 'navigate', unfocused: 'navigate-outline' },
  Tâches: { focused: 'checkbox', unfocused: 'checkbox-outline' },
  Cahiers: { focused: 'book', unfocused: 'book-outline' },
  Clients: { focused: 'people', unfocused: 'people-outline' },
  Plus: { focused: 'ellipsis-horizontal', unfocused: 'ellipsis-horizontal' },
};

const Tabs = createBottomTabNavigator();
const PlusStack = createNativeStackNavigator<PlusStackParams>();

/**
 * L'onglet « Plus » : une grille, puis l'écran choisi dans la même pile — on
 * revient d'un geste, sans perdre l'onglet où l'on était.
 */
function PlusFlow({
  identity,
  onSignedOut,
}: {
  identity: AuthIdentity | null;
  onSignedOut: () => void;
}) {
  return (
    <PlusStack.Navigator screenOptions={STACK_OPTIONS}>
      <PlusStack.Screen name="PlusIndex" options={{ title: 'Plus' }}>
        {({ navigation }) => (
          <PlusScreen
            identity={identity}
            onOpen={(name) => navigation.navigate(name as keyof PlusStackParams)}
          />
        )}
      </PlusStack.Screen>
      <PlusStack.Screen name="Bons" component={BonsFlow} options={{ headerShown: false }} />
      <PlusStack.Screen name="Documents" component={DocumentsFlow} options={{ headerShown: false }} />
      <PlusStack.Screen name="Stock" component={StockFlow} options={{ headerShown: false }} />
      <PlusStack.Screen name="Banque" component={BanqueScreen} options={{ title: 'Banque' }} />
      <PlusStack.Screen name="Activité" component={DashboardScreen} options={{ title: 'Activité' }} />
      <PlusStack.Screen name="Réglages" options={{ title: 'Réglages' }}>
        {() => <SettingsScreen identity={identity} onSignedOut={onSignedOut} />}
      </PlusStack.Screen>
    </PlusStack.Navigator>
  );
}

function MainTabs({
  identity,
  onSignedOut,
}: {
  identity: AuthIdentity | null;
  onSignedOut: () => void;
}) {
  const visible = (Object.keys(TAB_CHANNEL) as TabName[]).filter((tab) => {
    const channel = TAB_CHANNEL[tab];
    return !channel || !identity || mayCall(identity.role, channel);
  });

  // Le badge de l'onglet Tâches compte les **retards**, pas les tâches
  // ouvertes — un chiffre permanent ne serait que du bruit. La garde de rôle
  // de useResource fait que ce coût est nul pour un livreur.
  const { data: tasks } = useTasks();
  const today = new Date().toISOString().slice(0, 10);
  const lateTasks = tasks.filter(
    (t) => !t.deletedAt && t.status !== 'done' && t.dueDate && t.dueDate < today,
  ).length;

  return (
    <Tabs.Navigator
      screenOptions={({ route }) => ({
        // Les piles portent leur propre en-tête ; les écrans simples ont
        // besoin de celui de l'onglet.
        headerShown: route.name === 'Cahiers' || route.name === 'Tâches',
        headerShadowVisible: false,
        headerStyle: { backgroundColor: colors.bg },
        headerTitleStyle: { fontSize: 17, fontWeight: '700', color: colors.text },
        tabBarActiveTintColor: colors.accent,
        // `secondary`, pas `tertiary` : un onglet inactif se lit quand même.
        tabBarInactiveTintColor: colors.secondary,
        tabBarStyle: {
          backgroundColor: colors.card,
          borderTopColor: colors.separator,
        },
        tabBarLabelStyle: { fontSize: 12, fontWeight: '600' },
        tabBarIcon: ({ color, size, focused }) => (
          <Ionicons
            name={TAB_ICON[route.name as TabName][focused ? 'focused' : 'unfocused']}
            size={size - 2}
            color={color}
          />
        ),
      })}
    >
      {visible.includes('Tournées') && <Tabs.Screen name="Tournées" component={RoutesFlow} />}
      {visible.includes('Tâches') && (
        <Tabs.Screen
          name="Tâches"
          component={TachesScreen}
          options={{
            tabBarBadge: lateTasks || undefined,
            tabBarBadgeStyle: { backgroundColor: colors.red, fontSize: 11, fontWeight: '600' },
          }}
        />
      )}
      {visible.includes('Cahiers') && <Tabs.Screen name="Cahiers" component={CahiersScreen} />}
      {visible.includes('Clients') && <Tabs.Screen name="Clients" component={ClientsFlow} />}
      <Tabs.Screen name="Plus">
        {() => <PlusFlow identity={identity} onSignedOut={onSignedOut} />}
      </Tabs.Screen>
    </Tabs.Navigator>
  );
}

/* ------------------------------------------------------------------ */
/* Bandeau hors-ligne                                                  */
/* ------------------------------------------------------------------ */

function OfflineBanner() {
  const insets = useSafeAreaInsets();
  const [state, setState] = useState(() => syncStatus());
  const visibleRef = useRef(false);

  const refresh = useCallback(() => {
    const next = syncStatus();
    const nextVisible = !(next.online && next.pending.length === 0);
    if (nextVisible !== visibleRef.current) {
      visibleRef.current = nextVisible;
      // Le bandeau pousse toute l'app vers le bas — c'est voulu, le décalage
      // *est* l'information. L'animation adoucit seulement le mouvement.
      // (Pas de setLayoutAnimationEnabledExperimental : rite de l'ancienne
      // architecture, inutile sous Fabric.)
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    }
    setState(next);
  }, []);

  useEffect(() => {
    const off = onOfflineChange(refresh);
    const timer = setInterval(refresh, 10_000);
    refresh();
    return () => {
      off();
      clearInterval(timer);
    };
  }, [refresh]);

  if (state.online && state.pending.length === 0) return null;
  return (
    <View style={[styles.banner, { paddingTop: insets.top + 4 }]}>
      <Ionicons name="cloud-offline-outline" size={15} color="#fff" />
      <Text style={styles.bannerText}>
        {state.online
          ? `${state.pending.length} modification(s) en attente d’envoi`
          : `Hors ligne — travail sur la copie locale${
              state.pending.length ? ` · ${state.pending.length} en attente` : ''
            }`}
      </Text>
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* Porte d'entrée                                                      */
/* ------------------------------------------------------------------ */

type GateState =
  | { step: 'boot' }
  | { step: 'setup' }
  | { step: 'login' }
  | { step: 'main'; identity: AuthIdentity | null };

/**
 * Où mène chaque notification.
 *
 * Documents et Banque ne sont plus des onglets : ils vivent sous « Plus ».
 * La cible est donc décrite en deux temps — l'onglet, puis l'écran de sa
 * pile — sans quoi un clic sur « Nouvelle facture » ouvrirait l'accueil.
 */
const PAGE_TARGET: Record<
  string,
  { tab: TabName; screen?: keyof PlusStackParams; channel: ChannelName | null }
> = {
  taches: { tab: 'Tâches', channel: 'tasks:list' },
  cahiers: { tab: 'Cahiers', channel: 'registers:list' },
  documents: { tab: 'Plus', screen: 'Documents', channel: 'documents:list' },
  banque: { tab: 'Plus', screen: 'Banque', channel: 'bank:list' },
  bons: { tab: 'Plus', screen: 'Bons', channel: 'delivery:list' },
};

function Gate() {
  const [state, setState] = useState<GateState>({ step: 'boot' });
  const toast = useToast();
  const navigation = useRef<NavigationContainerRef<Record<string, undefined>> | null>(null);

  const enter = useCallback((identity: AuthIdentity | null) => {
    setCurrentRole(identity?.role ?? null);
    setState({ step: 'main', identity });
  }, []);

  useEffect(() => {
    // Session révoquée ou expirée pendant l'usage : retour à la connexion,
    // plutôt qu'une cascade d'erreurs.
    setAuthRequiredHandler(() => {
      setCurrentRole(null);
      setState({ step: 'login' });
    });
    void boot().then((result) => {
      if (!result.configured) setState({ step: 'setup' });
      else if (result.loginRequired) setState({ step: 'login' });
      else enter(result.identity);
    });
  }, [enter]);

  /* Vie de l'app : resynchronisation + retour du réseau. */
  useEffect(() => {
    if (state.step !== 'main') return;
    const stopLive = startLive(refreshAll);
    const stopOffline = onOfflineChange(({ online, replayed, failed }) => {
      if (!online) {
        toast.push({
          tone: 'warn',
          title: 'Hors ligne',
          text: 'Vos gestes de tournée sont conservés et seront envoyés à la reconnexion.',
        });
        return;
      }
      refreshAll();
      if (replayed || failed) {
        toast.push({
          tone: failed ? 'warn' : 'success',
          title: 'Connexion rétablie',
          text: [
            replayed ? `${replayed} modification(s) envoyée(s).` : '',
            failed ? `${failed} refusée(s) — voir Réglages.` : '',
          ]
            .filter(Boolean)
            .join(' '),
        });
      }
    });
    return () => {
      stopLive();
      stopOffline();
    };
  }, [state.step, toast]);

  /* Notifications natives ------------------------------------------- */
  useEffect(() => {
    if (state.step !== 'main') return;
    // Réaffirmé à chaque entrée dans l'application : Firebase renouvelle
    // parfois le jeton de lui-même, et un abonnement enregistré une fois pour
    // toutes finirait par ne plus réveiller personne, sans rien signaler.
    void registerForPush();

    // Le clic sur une notification ouvre l'onglet annoncé — mais seulement
    // s'il est visible pour ce rôle : le serveur ne pousse déjà rien
    // au-delà des droits, cette vérification est la ceinture.
    return onNotificationOpened((page) => {
      const target = PAGE_TARGET[page];
      if (!target || !navigation.current) return;
      // Ceinture : le serveur ne pousse déjà rien au-delà des droits.
      const identity = state.step === 'main' ? state.identity : null;
      if (target.channel && identity && !mayCall(identity.role, target.channel)) return;
      // La cible se décide à l'exécution (elle vient de la notification) :
      // le typage nominal de React Navigation ne peut rien en dire.
      const nav = navigation.current as unknown as {
        navigate: (name: string, params?: object) => void;
      };
      nav.navigate(target.tab, target.screen ? { screen: target.screen } : undefined);
    });
  }, [state]);

  if (state.step === 'boot') return <Loading />;
  if (state.step === 'setup') {
    return (
      <SetupScreen
        onDone={(status: AuthStatus) => {
          if (status.required && !status.identity) setState({ step: 'login' });
          else enter(status.identity);
        }}
      />
    );
  }
  if (state.step === 'login') {
    return <LoginScreen onDone={enter} onChangeServer={() => setState({ step: 'setup' })} />;
  }

  return (
    <View style={{ flex: 1 }}>
      <OfflineBanner />
      <NavigationContainer ref={navigation} theme={NAV_THEME}>
        <MainTabs
          identity={state.identity}
          onSignedOut={() => {
            setCurrentRole(null);
            setState({ step: 'login' });
          }}
        />
      </NavigationContainer>
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <ToastProvider>
        <StatusBar style="dark" />
        <Gate />
      </ToastProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: colors.orange,
    paddingBottom: 6,
    paddingHorizontal: 16,
  },
  bannerText: { color: '#fff', fontWeight: '600', fontSize: 13.5, textAlign: 'center' },
});
