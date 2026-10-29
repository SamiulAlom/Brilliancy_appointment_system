import { StrictMode, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import Booking from './Booking';
const Manage = lazy(() => import('./Manage'));
const Admin = lazy(() => import('./Admin'));
const Team = lazy(() => import('./Team'));
const path = location.pathname.replace(/\/+$/, '');
// Communication-team portal: /team (team members can also sign in from /admin with the switch).
const Page = path === '/admin' ? Admin : path === '/manage' ? Manage : path === '/team' ? Team : Booking;
createRoot(document.getElementById('root')!).render(<StrictMode><Suspense fallback={null}><Page/></Suspense></StrictMode>);
