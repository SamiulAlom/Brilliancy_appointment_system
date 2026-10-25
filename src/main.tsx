import { StrictMode, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import Booking from './Booking';
const Manage = lazy(() => import('./Manage'));
const Admin = lazy(() => import('./Admin'));
const path = location.pathname.replace(/\/+$/, '');
const Page = path === '/admin' ? Admin : path === '/manage' ? Manage : Booking;
createRoot(document.getElementById('root')!).render(<StrictMode><Suspense fallback={null}><Page/></Suspense></StrictMode>);
