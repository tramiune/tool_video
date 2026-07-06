import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: "AIzaSyDJ9XfVlMxBN8VvJG9uDMjClhNsRQm8tA8",
  authDomain: "meo3-e69a5.firebaseapp.com",
  projectId: "meo3-e69a5",
  storageBucket: "meo3-e69a5.firebasestorage.app",
  messagingSenderId: "393260819525",
  appId: "1:393260819525:web:b1179325a9040c7af96f2c"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
export const googleProvider = new GoogleAuthProvider();
