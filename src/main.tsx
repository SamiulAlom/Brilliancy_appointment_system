import { StrictMode, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import Booking from './Booking';
const Manage = lazy(() => import('./Manage'));
const Admin = lazy(() => import('./Admin'));
const Team = lazy(() => import('./Team'));
const path = location.pathname.replace(/\/+$/, '');
// The communication-team portal lives on its own subdomain (appointmentbooked.…) and also at /team.
const teamHost = location.hostname.startsWith('appointmentbooked.');
const Page = path === '/admin' ? Admin : path === '/manage' ? Manage : path === '/team' || teamHost ? Team : Booking;
createRoot(document.getElementById('root')!).render(<StrictMode><Suspense fallback={null}><Page/></Suspense></StrictMode>);
