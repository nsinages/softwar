/**
 * Generic stat tile used on the Dashboard (Total Media, Videos, Images, Storage).
 */
export default function StatusCard({ icon: Icon, label, value, accent = "primary" }) {
  return (
    <div className="card stat-card">
      <div className={`stat-card-icon stat-card-icon-${accent}`}>
        <Icon size={18} />
      </div>
      <div className="stat-card-value">{value}</div>
      <div className="stat-card-label">{label}</div>
    </div>
  );
}
