import React, { useState, useEffect, createContext, useContext } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged, signOut } from 'firebase/auth';
import { getFirestore, doc, getDoc, setDoc, updateDoc, onSnapshot } from 'firebase/firestore';

// Lucide-react icons used throughout the app - FIX: Changed Square to Target
import { Rocket, Crown, User, LogOut, Loader2, Trophy, Target, Ticket, Calendar, Banknote, Users } from 'lucide-react'; 

// For toast notifications
import { ToastContainer } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';

// Import contexts and custom hooks from the new contexts module
import { FirebaseContext, UserContext, useFirebase, useUser } from './contexts';

// Import components from the components directory
import NFLGamePicks from './components/NFLGamePicks';
import LeaderboardDashboard from './components/LeaderboardDashboard';
// Assuming DailyBonus and LotterySweepstakes are re-exported from src/components/index.js
import { DailyBonus, LotterySweepstakes } from './components';

const App = () => {
  const [firebaseApp, setFirebaseApp] = useState(null);
  const [db, setDb] = useState(null);
  const [auth, setAuth] = useState(null);
  const [user, setUser] = useState(null); // Firebase Auth user object
  const [userId, setUserId] = useState(null); // Our internal userId, could be UID or anonymous ID
  const [userData, setUserData] = useState(null); // User data from Firestore
  const [loading, setLoading] = useState(true);
  const [authReady, setAuthReady] = useState(false); // Flag to ensure auth is ready before Firestore ops

  // --- Firebase Initialization and Authentication ---
  useEffect(() => {
    try {
      const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
      const app = initializeApp(firebaseConfig);
      const dbInstance = getFirestore(app);
      const authInstance = getAuth(app);

      setFirebaseApp(app);
      setDb(dbInstance);
      setAuth(authInstance);

      // Listen for auth state changes
      const unsubscribe = onAuthStateChanged(authInstance, async (currentUser) => {
        if (currentUser) {
          setUser(currentUser);
          setUserId(currentUser.uid);
          console.log('Firebase: User signed in:', currentUser.uid);
        } else {
          console.log('Firebase: No user signed in, attempting anonymous sign-in...');
          try {
            const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;
            if (initialAuthToken) {
              await signInWithCustomToken(authInstance, initialAuthToken);
              console.log('Firebase: Signed in with custom token.');
            } else {
              await signInAnonymously(authInstance);
              console.log('Firebase: Signed in anonymously.');
            }
          } catch (error) {
            console.error('Firebase: Error during anonymous/custom token sign-in:', error);
          }
        }
        setAuthReady(true); // Auth state is now confirmed
        setLoading(false); // Authentication part is done loading
      });

      return () => unsubscribe(); // Cleanup auth listener on component unmount
    } catch (error) {
      console.error("Firebase: Error initializing Firebase:", error);
      setLoading(false); // Mark loading as false even on error
    }
  }, []); // Empty dependency array means this runs once on mount

  // --- Fetch or Create User Data in Firestore ---
  useEffect(() => {
    // This effect runs only when Firebase is initialized, auth is ready, and userId is set
    if (authReady && db && userId) {
      const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
      const userDocRef = doc(db, `artifacts/${appId}/users/${userId}/profile`, 'data');

      // Listen for real-time updates to the user's profile document
      const unsubscribe = onSnapshot(userDocRef, async (docSnap) => {
        if (docSnap.exists()) {
          console.log('Firestore: User data found:', docSnap.data());
          setUserData(docSnap.data());
        } else {
          // If user data doesn't exist, create a new default profile
          console.log('Firestore: User data not found, creating new profile...');
          const initialData = {
            predictorPoints: 5000, // Initial balance of Predictor Points
            winnerBucks: 1,       // Initial balance of Winner Bucks
            xp: 0,
            lastDailyBonusClaim: null, // Track last daily bonus claim time
            created_at: new Date().toISOString(), // Timestamp of profile creation
            weeklyEntries: { // Track weekly entries for prediction games
              'default-week': 0 // Initialize for a default week or current NFL week
            },
            username: `User_${userId.substring(0, 4)}`, // Default username derived from User ID
          };
          try {
            await setDoc(userDocRef, initialData); // Set the new document
            setUserData(initialData); // Update local state
            console.log('Firestore: New user profile created.');
          } catch (error) {
            console.error('Firestore: Error creating user profile:', error);
          }
        }
      }, (error) => {
        console.error("Firestore: Error listening to user data:", error);
        // If there's an error fetching user data, still stop loading
        setLoading(false);
      });

      return () => unsubscribe(); // Cleanup Firestore listener on component unmount
    }
  }, [authReady, db, userId]); // Re-run when authReady, db, or userId changes

  // --- Overall Loading State ---
  // Display loader until Firebase is ready and initial user data is loaded
  if (loading || !authReady || !userData) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900 text-white">
        <Loader2 className="animate-spin h-10 w-10 text-blue-500" />
        <p className="ml-4 text-lg">Loading Application...</p>
      </div>
    );
  }

  // --- Main Application Render ---
  return (
    // Provide Firebase and user data through contexts to all children components
    <FirebaseContext.Provider value={{ firebaseApp, db, auth }}>
      <UserContext.Provider value={{ user, userId, userData, setUserData }}>
        <div className="min-h-screen bg-gradient-to-br from-gray-900 to-black text-white font-inter flex flex-col items-center p-4">
          <Header /> {/* Application header */}
          <MainContent /> {/* Main content area with tab navigation */}
          <Footer /> {/* Application footer */}
          <ToastContainer position="top-right" autoClose={3000} /> {/* Toast notifications */}
        </div>
      </UserContext.Provider>
    </FirebaseContext.Provider>
  );
};

// --- Header Component (Displays App Title, User ID, and Balances) ---
const Header = () => {
  const { auth } = useFirebase(); // Access Firebase Auth from context
  const { userId, userData } = useUser(); // Access user data from context

  // Handle user sign out
  const handleSignOut = async () => {
    try {
      await signOut(auth);
      console.log('Firebase: User signed out.');
    } catch (error) {
      console.error('Firebase: Error signing out:', error);
    }
  };

  return (
    <header className="w-full max-w-4xl bg-gray-800 p-4 rounded-xl shadow-lg flex flex-col sm:flex-row items-center justify-between mb-8">
      <h1 className="text-3xl font-bold text-blue-400 mb-4 sm:mb-0">
        <Trophy className="inline-block mr-2" size={32} />
        PredictPro
      </h1>
      <div className="flex flex-col items-center sm:items-end">
        {userId && (
          <p className="text-sm text-gray-300 mb-2">
            User ID: <span className="font-mono text-blue-300 text-xs break-all">{userId}</span>
          </p>
        )}
        {userData && (
          <div className="flex items-center space-x-4 mb-2">
            {/* Predictor Points display */}
            <div className="flex items-center bg-gray-700 rounded-full px-3 py-1 shadow-inner">
              <Rocket className="h-5 w-5 text-purple-400 mr-2" />
              <span className="text-lg font-semibold">{userData.predictorPoints || 0}</span>
              <span className="text-xs text-gray-400 ml-1">Points</span>
            </div>
            {/* Winner Bucks display */}
            <div className="flex items-center bg-gray-700 rounded-full px-3 py-1 shadow-inner">
              <Crown className="h-5 w-5 text-yellow-400 mr-2" />
              <span className="text-lg font-semibold">
                {userData.winnerBucks !== undefined ? parseFloat(userData.winnerBucks).toFixed(2) : '0.00'}
              </span>
              <span className="text-xs text-gray-400 ml-1">Bucks</span>
            </div>
          </div>
        )}
        {auth && auth.currentUser && (
          <button
            onClick={handleSignOut}
            className="mt-2 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-full flex items-center text-sm transition-all duration-300 transform hover:scale-105 shadow-md"
          >
            <LogOut className="h-4 w-4 mr-2" /> Sign Out
          </button>
        )}
      </div>
    </header>
  );
};

// --- Main Content Component (Handles Tab Navigation) ---
const MainContent = () => {
  const [activeTab, setActiveTab] = useState('games'); // Default active tab

  return (
    <main className="w-full max-w-4xl bg-gray-800 p-6 rounded-xl shadow-lg flex flex-col items-center">
      <h2 className="text-2xl font-semibold text-center text-blue-300 mb-6">Welcome to PredictPro NFL!</h2>
      <p className="text-gray-300 text-center mb-8">
        Make your NFL predictions, climb the leaderboards, and win!
      </p>

      {/* Navigation Tabs */}
      <div className="flex justify-center space-x-4 mb-8">
        <button
          onClick={() => setActiveTab('games')}
          className={`px-5 py-2 rounded-full font-semibold transition-colors ${
            activeTab === 'games' ? 'bg-blue-600 text-white shadow-md' : 'bg-gray-700 text-gray-300 hover:bg-blue-500 hover:text-white'
          }`}
        >
          {/* Replaced Square with Target icon here and set color */}
          <Target className="inline-block mr-2" size={20} color="#07df32" /> Make Picks
        </button>
        <button
          onClick={() => setActiveTab('dashboard')}
          className={`px-5 py-2 rounded-full font-semibold transition-colors ${
            activeTab === 'dashboard' ? 'bg-blue-600 text-white shadow-md' : 'bg-gray-700 text-gray-300 hover:bg-blue-500 hover:text-white'
          }`}
        >
          <Users className="inline-block mr-2" size={20} /> Leaderboard & My Picks
        </button>
        <button
          onClick={() => setActiveTab('lottery')}
          className={`px-5 py-2 rounded-full font-semibold transition-colors ${
            activeTab === 'lottery' ? 'bg-blue-600 text-white shadow-md' : 'bg-gray-700 text-gray-300 hover:bg-blue-500 hover:text-white'
          }`}
        >
          <Ticket className="inline-block mr-2" size={20} /> Lottery
        </button>
      </div>

      {/* Conditional Content Rendering based on activeTab */}
      {activeTab === 'games' && (
        <>
          <DailyBonus />
          <NFLGamePicks />
        </>
      )}
      {activeTab === 'dashboard' && <LeaderboardDashboard />}
      {activeTab === 'lottery' && <LotterySweepstakes />}

      {/* "What's Next" section */}
      <section className="w-full text-center mt-8">
        <h3 className="text-xl font-semibold text-blue-300 mb-4">What's Next?</h3>
        <p className="text-gray-400">We're constantly improving! Look forward to:</p>
        <ul className="list-disc list-inside text-left text-gray-400 mt-4 space-y-2">
          <li>Full implementation of prediction settlement based on game outcomes.</li>
          <li>Real-time score updates for NFL games (requires actual API integration).</li>
          <li>User achievements and friend system.</li>
          <li>Store for purchasing Predictor Points.</li>
          <li>Robust redemption for Winner Bucks.</li>
        </ul>
      </section>
    </main>
  );
};

// --- Footer Component ---
const Footer = () => {
  return (
    <footer className="w-full max-w-4xl text-center text-gray-500 text-sm mt-8 p-4 border-t border-gray-700">
      <p>© {new Date().getFullYear()} PredictPro. All rights reserved.</p>
      <p className="mt-2">Inspired by Fliff's sweepstakes model.</p>
    </footer>
  );
};

export default App;
