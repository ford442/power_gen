# Claude Development Guide for SEG WebGPU Visualizer

## Project Overview
This project is a real-time WebGPU simulation of the Searl Effect Generator (SEG) with extensible architecture for future additions like Heron's Fountain and Kelvin's Thunderstorm.

**Live Demo:** https://ford442.github.io/seg-webgpu-visualizer/

## Key Features
- 12 instanced magnetic rollers in toroidal formation
- 10,000-50,000 GPU compute shader particles
- Interactive orbital camera (drag to rotate, scroll to zoom)
- Three visualization modes: SEG, Heron's Fountain, Kelvin's Thunderstorm

## Browser Requirements
- Chrome/Edge 113+ with WebGPU enabled
- HTTPS or localhost

## Project Structure
```
power_gen/
├── README.md              # User-facing project documentation
├── claude.md              # This file - development guide
├── index.html             # Main HTML entry point
├── main.js                # Core WebGPU simulation and rendering logic
├── deploy.py              # Python script for SFTP deployment to 1ink.us
├── git.sh                 # Shell script for git operations
├── shaders/
│   └── seg-magnetic.wgsl  # WebGPU shader for SEG magnetic field simulation
└── .github/workflows/
    └── static.yml         # GitHub Actions for static site deployment
```

## Local Development

### Prerequisites
- Node.js with npm (for serving locally)
- WebGPU capable browser

### Running Locally
```bash
# Serve with HTTPS (required for WebGPU)
npx serve . --ssl
```
Then navigate to `https://localhost:3000` in your browser.

## Key Files and Their Purposes

### main.js
The core file containing:
- WebGPU instance initialization
- Particle simulation logic
- Rendering pipeline
- Camera controls
- State management for visualization modes

### shaders/seg-magnetic.wgsl
WebGPU shader code that computes:
- Magnetic field calculations for the toroidal roller configuration
- Particle physics updates
- Output for rendering

### index.html
Minimal HTML entry point that:
- Sets up the canvas element
- Loads main.js
- Provides basic UI structure

## Deployment

### GitHub Pages (Automatic)
- Triggered by `.github/workflows/static.yml` on push to main
- Deploys to: https://ford442.github.io/seg-webgpu-visualizer/

### Manual SFTP Deployment
```bash
python deploy.py
```
- Uploads `dist/` directory to `1ink.us` server
- Server: `1ink.us:22`
- Remote path: `test.1ink.us/powergen`
- Username: `ford442`
- Password: stored in script (use environment variables in production)

## Development Workflow

1. Make changes to code/shaders
2. Test locally with `npx serve . --ssl`
3. Commit with clear messages
4. Push to appropriate branch
5. For main branch, GitHub Actions auto-deploys to GitHub Pages
6. For manual deployment to 1ink.us, run `python deploy.py`

## Git Branches
- `main` - Production-ready code, auto-deploys to GitHub Pages
- `claude/create-claude-md-*` - Claude Code development branches
- Use descriptive branch names for features/fixes

## Architecture Notes

### WebGPU Pipeline
The simulation uses a compute shader to update particle positions based on the magnetic field, then renders using the standard graphics pipeline.

### Particle System
- Configurable particle count (10k-50k)
- Uses GPU buffers for efficient computation
- Real-time updates without CPU bottleneck

### Camera System
- Orbital controls centered on simulation
- Drag to rotate, scroll to zoom
- Smooth animation

## Common Tasks

### Adding a New Visualization Mode
1. Add mode constant to main.js
2. Implement physics in seg-magnetic.wgsl
3. Add UI toggle in index.html
4. Update README with new feature

### Modifying Particle Count
- Adjust in main.js initialization
- Consider GPU memory constraints
- Test performance in target browsers

### Updating Shader Logic
- Edit shaders/seg-magnetic.wgsl
- Test locally with `npx serve . --ssl`
- Verify performance impact

## Troubleshooting

### WebGPU Not Available
- Ensure Chrome/Edge 113+
- Check that WebGPU is enabled in browser flags
- Use HTTPS or localhost

### Slow Performance
- Reduce particle count in main.js
- Check browser GPU usage
- Profile with Chrome DevTools

### Deployment Issues
- Verify dist/ directory exists (may need build step)
- Check 1ink.us credentials in deploy.py
- Ensure network connectivity for SFTP

## Future Enhancements
- Heron's Fountain simulation
- Kelvin's Thunderstorm simulation
- Performance optimizations
- Mobile WebGPU support
- Advanced camera controls

## Contact & Resources
- Repository: https://github.com/ford442/power_gen
- Live Demo: https://ford442.github.io/seg-webgpu-visualizer/
