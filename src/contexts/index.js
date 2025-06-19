    // src/contexts/index.js
    import React, { createContext, useContext } from 'react';

    // Create contexts for Firebase and user data
    export const FirebaseContext = createContext(null);
    export const UserContext = createContext(null);

    // Custom hook to use Firebase services
    export const useFirebase = () => useContext(FirebaseContext);
    // Custom hook to use user data
    export const useUser = () => useContext(UserContext);
    