const fs=require('fs');
const path=require('path');
const cp=require('child_process');
const root=__dirname;
const providerRoot=path.join(root,'.pot-provider');
const pluginRoot=path.join(root,'yt-dlp-plugins','bgutil-ytdlp-pot-provider');
function run(cmd,args,cwd){cp.execFileSync(cmd,args,{cwd,stdio:'inherit'});}
if(fs.existsSync(path.join(providerRoot,'server','build','generate_once.js'))&&fs.existsSync(pluginRoot))process.exit(0);
fs.rmSync(providerRoot,{recursive:true,force:true});
fs.rmSync(path.join(root,'yt-dlp-plugins'),{recursive:true,force:true});
fs.mkdirSync(path.join(root,'yt-dlp-plugins'),{recursive:true});
run('git',['clone','--depth','1','https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git',providerRoot],root);
run('npm',['ci'],path.join(providerRoot,'server'));
run('npx',['tsc'],path.join(providerRoot,'server'));
fs.cpSync(path.join(providerRoot,'plugin'),pluginRoot,{recursive:true});
console.log('AutoTube PO token provider installed');