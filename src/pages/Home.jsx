// =============================================
// N Signage — Home page for logged-out visitors (hosted website)
// =============================================
import React from 'react';
import { Link } from 'react-router-dom';
import { LogIn, UserPlus, Tv, UploadCloud, ShieldCheck, Wifi } from 'lucide-react';
import PublicHeader from '../components/PublicHeader';

const FEATURES = [
  { icon: Tv, title: 'All your displays in one place', text: 'See which Raspberry Pi displays are online and what they are playing.' },
  { icon: UploadCloud, title: 'Upload from anywhere', text: 'Send images and videos to a display from your phone or computer, on any network.' },
  { icon: Wifi, title: 'Easy to add', text: 'Add a display from the same Wi-Fi, or with the pairing code shown on its screen.' },
  { icon: ShieldCheck, title: 'Private to your account', text: 'Only you can see and control your displays. No email address needed.' },
];

export default function Home({ notice }) {
  return (
    <div className="public-page">
      <PublicHeader />
      <main className="home-main">
        {notice && <div className="alert alert-info home-notice" role="status">{notice}</div>}
        <section className="home-hero">
          <h1>Manage your digital signage displays</h1>
          <p>Log in to see your N-Signage displays, add new ones and upload media to them from anywhere.</p>
          <div className="home-actions">
            <Link to="/login" className="btn btn-primary btn-lg"><LogIn size={16} /> Log in</Link>
            <Link to="/register" className="btn btn-secondary btn-lg"><UserPlus size={16} /> Create account</Link>
          </div>
        </section>
        <section className="home-features" aria-label="Features">
          {FEATURES.map(({ icon: Icon, title, text }) => (
            <div key={title} className="card home-feature">
              <div className="home-feature-icon"><Icon size={18} /></div>
              <div>
                <h2>{title}</h2>
                <p>{text}</p>
              </div>
            </div>
          ))}
        </section>
      </main>
    </div>
  );
}
