import { useEffect, useState } from 'react';
import Home from './pages/Home';
import Practice from './pages/Practice';
import Browse from './pages/Browse';
import Review from './pages/Review';

/** #/ , #/practice?subject=理論&n=10(&kind=calc) , #/browse , #/card/<id> , #/review */
function useHash() {
  const [hash, setHash] = useState(() => location.hash.slice(1) || '/');
  useEffect(() => {
    const on = () => setHash(location.hash.slice(1) || '/');
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return hash;
}

export const go = (path: string) => { location.hash = path; };

export default function App() {
  const hash = useHash();
  const [path, query] = hash.split('?');
  const params = new URLSearchParams(query);
  if (path === '/review') return <Review />;
  if (path === '/practice') return <Practice key={hash} subject={params.get('subject')} count={Number(params.get('n') ?? 20)} mode={params.get('mode') === 'extra' ? 'extra' : 'today'} kind={params.get('kind') === 'calc' ? 'calc' : 'goro'} />;
  if (path.startsWith('/card/')) return <Practice key={hash} cardId={decodeURIComponent(path.slice(6))} />;
  if (path === '/browse') return <Browse />;
  return <Home />;
}
