import { Capacitor } from '@capacitor/core';
import { GoogleAuth } from '@southdevs/capacitor-google-auth';
import { auth, googleProvider } from '../firebase';
import { signInWithPopup, signInWithCredential, GoogleAuthProvider, signOut } from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';

const isNative = Capacitor.isNativePlatform();

let initialized = false;

function ensureInitialized() {
  if (!initialized && isNative) {
    GoogleAuth.initialize({
      clientId: firebaseConfig.googleWebClientId || undefined,
      scopes: ['profile', 'email'],
    });
    initialized = true;
  }
}

export async function signInWithGoogle() {
  if (isNative) {
    ensureInitialized();
    const googleUser = await GoogleAuth.signIn({ scopes: ['profile', 'email'] });
    const credential = GoogleAuthProvider.credential(googleUser.authentication.idToken);
    return signInWithCredential(auth, credential);
  } else {
    return signInWithPopup(auth, googleProvider);
  }
}

export function signOutUser() {
  if (isNative) {
    ensureInitialized();
    GoogleAuth.signOut().catch(() => {});
  }
  return signOut(auth);
}

export { onAuthStateChanged } from 'firebase/auth';
export { auth };
