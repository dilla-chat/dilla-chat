import './MeshBottomBar.css';

export default function MeshBottomBar() {
  return (
    <footer
      className="mesh-bottom-bar"
      role="contentinfo"
      aria-label="Mesh bottom bar"
    >
      <span className="mesh-bottom-bar-placeholder">
        node · peers · lamport · e2e
      </span>
    </footer>
  );
}
