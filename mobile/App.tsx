import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import type { AuthIdentity, AuthStatus, ChannelName } from '@shared/api';
import { mayCall } from '@shared/api';
import { boot, setAuthRequiredHandler, startLive } from './src/lib/runtime';
import { onOfflineChange, syncStatus } from './src/core/offline';
import { refreshAll, setCurrentRole } from './src/lib/data';
import { Loading, ToastProvider, useToast } from './src/components/ui';
import { colors } from './src/theme';
import { SetupScreen } from './src/screens/Setup';
import { LoginScreen } from './src/screens/Login';
import { RouteDetailScreen, RoutesListScreen, type RoutesStackParams } from './src/screens/Routes';
import { ClientDetailScreen, ClientsListScreen, type ClientsStackParams } from './src/screens/Clients';
import {
  DocumentDetailScreen,
  DocumentsListScreen,
  type DocumentsStackParams,
} from './src/screens/Documents';
import { ProductDetailScreen, StockListScreen, type StockStackParams } from './src/screens/Stock';
import { CahiersScreen } from './src/screens/Cahiers';
import { BanqueScreen } from './src/screens/Banque';
import { DashboardScreen } from './src/screens/Dashboard';
import { SettingsScreen } from './src/screens/Settings';

/**
 * CompaGelato mobile — la même donnée que le bureau et le navigateur, par le
 * même serveur, avec les mêmes droits. Une seule base de code, Android et iOS.
 */

/* ------------------------------------------------------------------ */
/* Piles de navigation                                                 */
/* ------------------------------------------------------------------ */

const RoutesStack = createNativeStackNavigator<RoutesStackParams>();
const ClientsStack = createNativeStackNavigator<ClientsStackParams>();
const DocumentsStack = createNativeStackNavigator<DocumentsStackParams>();
const StockStack = createNativeStackNavigator<StockStackParams>();

function RoutesFlow() {
  return (
    <RoutesStack.Navigator>
      <RoutesStack.Screen name="RoutesList" component={RoutesListScreen} options={{ title: 'Tournées' }} />
      <RoutesStack.Screen name="RouteDetail" component={RouteDetailScreen} options={{ title: 'Tournée' }} />
    </RoutesStack.Navigator>
  );
}

function ClientsFlow() {
  return (
    <ClientsStack.Navigator>
      <ClientsStack.Screen name="ClientsList" component={ClientsListScreen} options={{ title: 'Clients' }} />
      <ClientsStack.Screen name="ClientDetail" component={ClientDetailScreen} options={{ title: 'Client' }} />
    </ClientsStack.Navigator>
  );
}

function DocumentsFlow() {
  return (
    <DocumentsStack.Navigator>
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
    <StockStack.Navigator>
      <StockStack.Screen name="StockList" component={StockListScreen} options={{ title: 'Stock' }} />
      <StockStack.Screen name="ProductDetail" component={ProductDetailScreen} options={{ title: 'Article' }} />
    </StockStack.Navigator>
  );
}

/* ------------------------------------------------------------------ */
/* Onglets, filtrés par rôle                                           */
/* ------------------------------------------------------------------ */

type TabName =
  | 'Tournées'
  | 'Clients'
  | 'Documents'
  | 'Stock'
  | 'Cahiers'
  | 'Banque'
  | 'Activité'
  | 'Réglages';

/**
 * Le canal qui décide de la visibilité de chaque onglet — même mécanique que
 * le bureau : le masquage est un confort, le serveur refuse de toute façon.
 * Un livreur voit trois onglets : Tournées, Clients, Réglages.
 */
const TAB_CHANNEL: Record<TabName, ChannelName | null> = {
  Tournées: 'routes:list',
  Clients: 'clients:list',
  Documents: 'documents:list',
  Stock: 'products:list',
  Cahiers: 'registers:list',
  Banque: 'bank:list',
  Activité: 'stats:dashboard',
  Réglages: null,
};

const TAB_ICON: Record<TabName, keyof typeof Ionicons.glyphMap> = {
  Tournées: 'navigate-outline',
  Clients: 'people-outline',
  Documents: 'document-text-outline',
  Stock: 'cube-outline',
  Cahiers: 'book-outline',
  Banque: 'card-outline',
  Activité: 'stats-chart-outline',
  Réglages: 'settings-outline',
};

const Tabs = createBottomTabNavigator();

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

  return (
    <Tabs.Navigator
      screenOptions={({ route }) => ({
        headerShown:
          route.name === 'Cahiers' ||
          route.name === 'Banque' ||
          route.name === 'Activité' ||
          route.name === 'Réglages',
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.tertiary,
        tabBarLabelStyle: { fontSize: 10 },
        tabBarIcon: ({ color, size }) => (
          <Ionicons name={TAB_ICON[route.name as TabName]} size={size - 2} color={color} />
        ),
      })}
    >
      {visible.includes('Tournées') && <Tabs.Screen name="Tournées" component={RoutesFlow} />}
      {visible.includes('Clients') && <Tabs.Screen name="Clients" component={ClientsFlow} />}
      {visible.includes('Documents') && <Tabs.Screen name="Documents" component={DocumentsFlow} />}
      {visible.includes('Stock') && <Tabs.Screen name="Stock" component={StockFlow} />}
      {visible.includes('Cahiers') && <Tabs.Screen name="Cahiers" component={CahiersScreen} />}
      {visible.includes('Banque') && <Tabs.Screen name="Banque" component={BanqueScreen} />}
      {visible.includes('Activité') && <Tabs.Screen name="Activité" component={DashboardScreen} />}
      <Tabs.Screen name="Réglages">
        {() => <SettingsScreen identity={identity} onSignedOut={onSignedOut} />}
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

  useEffect(() => {
    const off = onOfflineChange(() => setState(syncStatus()));
    const timer = setInterval(() => setState(syncStatus()), 10_000);
    return () => {
      off();
      clearInterval(timer);
    };
  }, []);

  if (state.online && state.pending.length === 0) return null;
  return (
    <View style={[styles.banner, { paddingTop: insets.top + 4 }]}>
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

function Gate() {
  const [state, setState] = useState<GateState>({ step: 'boot' });
  const toast = useToast();

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
      <NavigationContainer>
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
  bannerText: { color: '#fff', fontWeight: '600', fontSize: 12.5, textAlign: 'center' },
});
