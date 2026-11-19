import '@fontsource/inter/latin-400.css'
import '@fontsource/inter/latin-500.css'
import '@fontsource/inter/latin-600.css'
import '@fontsource/jetbrains-mono/latin-400.css'
import './styles/tokens.css'
import './styles/app.css'
import './styles/landscape.css'
import './styles/aura.css'
import { render } from 'preact'
import { App } from './app'
import { speech } from './audio/speech'
import { Client, socketUrl } from './protocol/client'
import { setClient } from './ui'
import { trackInput } from './input'

const client = new Client({
  url: socketUrl(),
  onAudio: (pcm) => speech.push(pcm),
  onEvent: (e) => {
    if (e.type === 'speech.start') speech.start(e.sample_rate)
    else if (e.type === 'speech.clip') speech.playClip(e.url)
    else if (e.type === 'speech.end') {
      if (e.reason === 'done') speech.end()
      else speech.stop()
    }
  },
})
setClient(client)
trackInput()
// The page never leaves: no navigation, no context menu, no pinch-zoom of the whole UI.
window.addEventListener('contextmenu', (e) => e.preventDefault())
document.addEventListener('gesturestart', (e) => e.preventDefault())
render(<App />, document.getElementById('app')!)
client.connect()
