// =============================================
// N Signage — Header for logged-out visitors (hosted website)
// =============================================
import React from 'react';
import { Link, NavLink } from 'react-router-dom';
import logo from '../assets/logo.png';

const LINKS = [
  { to: '/', label: 'Home', end: true },
  { to: '/login', label: 'Log in' },
  { to: '/register', label: 'Create account', primary: true },
];

export default function PublicHeader() {
  return (
    <header className="public-header">
      <Link to="/" className="public-brand" aria-label="N-Signage home">
        <img src={logo} alt="N-Sinages — Digital Sinage Solution" />
      </Link>
      <nav className="public-nav" aria-label="Main">
        {LINKS.map(({ to, label, end, primary }) => (
          <NavLink key={to} to={to} end={end}
            className={({ isActive }) => `public-link${primary ? ' btn btn-primary btn-sm' : ''}${isActive && !primary ? ' active' : ''}`}>
            {label}
          </NavLink>
        ))}
      </nav>
    </header>
  );
}
