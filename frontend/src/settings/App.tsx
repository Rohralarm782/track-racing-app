import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import Layout from './components/Layout';
import EventList from './pages/EventList';
import CreateEvent from './pages/CreateEvent';
import EventDetail from './pages/EventDetail';
import CategoryDetail from './pages/CategoryDetail';
import RaceDetail from './pages/RaceDetail';
import PursuitPage from './pages/PursuitPage';
import CommuniquesPage from './pages/CommuniquesPage';
import SchedulePage from './pages/SchedulePage';
import SettingsPage from './pages/SettingsPage';

const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true,            element: <EventList /> },
      { path: 'events/new',     element: <CreateEvent /> },
      { path: 'events/:id',     element: <EventDetail /> },
      { path: 'events/:id/communiques', element: <CommuniquesPage /> },
      { path: 'events/:id/schedule',    element: <SchedulePage /> },
      { path: 'categories/:id', element: <CategoryDetail /> },
      { path: 'races/:id',      element: <RaceDetail /> },
      { path: 'pursuit', element: <PursuitPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
